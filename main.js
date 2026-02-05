const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const si = require('systeminformation');
const loudness = require('loudness');
const fs = require('fs'); // [NEW] 파일 시스템 모듈 추가

const isMac = process.platform === 'darwin';
// ★ [필수] 사용자 클릭 없이도 TTS/소리 재생 허용
// ★ [필수] 사용자 클릭 없이도 TTS/소리 재생 허용 (삭제됨)

let tray = null;
let bubbleWindow = null;
let petWindow = null;
let settingsWindow = null; // 설정 창 변수
let statusCheckInterval = null;
let dragInterval = null;

// --- [전역 설정 변수] ---
// --- [전역 설정 변수] ---
// 기본값 정의
const defaultConfig = {
    interval: 30000,   // 기본 5초
    soundVolume: 50,   // 기본 볼륨 50%
    character: 'pig',
    showPet: true,
    birthday: { month: 0, day: 0 }
};

let appConfig = loadConfig(); // 저장된 설정 불러오기

// [NEW] 설정 저장 경로 (앱 데이터 폴더/config.json)
function getConfigPath() {
    return path.join(app.getPath('userData'), 'config.json');
}

// [NEW] 설정 불러오기 함수
function loadConfig() {
    try {
        const configPath = getConfigPath();
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf-8');
            return { ...defaultConfig, ...JSON.parse(data) }; // 기본값 + 저장된값 병합
        }
    } catch (e) {
        console.error('설정 로드 실패:', e);
    }
    return { ...defaultConfig };
}

// [NEW] 설정 저장 함수
function saveConfig(config) {
    try {
        fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('설정 저장 실패:', e);
    }
}

let isForcedSleep = false; // [NEW] 강제 수면 상태인지 체크

app.whenReady().then(() => {
    if (isMac) app.dock.hide();

    // 1. 초기 아이콘 결정 (시작하자마자 생일인지 체크)
    let startIcon = 'normal.png';
    if (checkIsBirthday()) startIcon = 'birthday.png'; // 생일이면 시작부터 생일 아이콘!

    const iconPath = path.join(__dirname, 'assets', appConfig.character, startIcon);
    tray = new Tray(createTrayIcon(iconPath));
    tray.setToolTip('노는 중...');

    createPetWindow();

    createBubbleWindow();

    // 2. 트레이 클릭 이벤트 (자는 중이면 말풍선 안 띄움)
    tray.on('click', () => {
        if (!isForcedSleep) {
            toggleBubble();
        }
    });

    tray.on('right-click', () => {
        tray.popUpContextMenu();
    });

    // 3. 우클릭 메뉴 생성 (초기 상태)
    updateContextMenu();

    // 4. 시스템 감시 시작
    startStatusCheck();

    if (isMac) createMacMenu();

    // --- IPC 이벤트 ---
    ipcMain.on('hide-bubble', () => {
        if (bubbleWindow) bubbleWindow.hide();
    });

    ipcMain.on('resize-bubble', (event, { width, height }) => {
        if (!bubbleWindow) return;
        bubbleWindow.setSize(width, height);

        const { x, y } = getBubblePosition(width, height);
        bubbleWindow.setPosition(x, y);
    });

    ipcMain.on('update-config', (event, newConfig) => {
        const intervalChanged = appConfig.interval !== newConfig.interval;
        const charChanged = appConfig.character !== newConfig.character;
        const showPetChanged = appConfig.showPet !== newConfig.showPet;
        const birthdayChanged = JSON.stringify(appConfig.birthday) !== JSON.stringify(newConfig.birthday);

        appConfig = newConfig; // 설정값 업데이트
        saveConfig(appConfig); // [NEW] 변경된 설정 파일로 저장

        if (intervalChanged) startStatusCheck();

        // 1. 펫 윈도우 켜기/끄기 즉시 반영
        if (showPetChanged) {
            if (appConfig.showPet) {
                if (petWindow) petWindow.show();
            } else {
                if (petWindow) petWindow.hide();
            }
            // 말풍선 위치 재조정
            if (bubbleWindow && bubbleWindow.isVisible()) {
                const bounds = bubbleWindow.getBounds();
                const { x, y } = getBubblePosition(bounds.width, bounds.height);
                bubbleWindow.setPosition(x, y);
            }

            // [Mac 수정] 펫 켜기/끄기에 따라 워크스페이스 따라가기 여부 결정
            if (isMac && bubbleWindow && !bubbleWindow.isDestroyed()) {
                bubbleWindow.setVisibleOnAllWorkspaces(appConfig.showPet, { visibleOnFullScreen: true });
            }
        }

        // 2. ★ [핵심] 캐릭터가 바뀌었거나 생일 설정이 바뀌었으면 "즉시" 이미지 교체
        if (charChanged || birthdayChanged) {
            // 현재 자는 중이면 sleep.png, 아니면 (생일이면 birthday.png, 아니면 normal.png)를 바로 보여줌
            const baseIcon = checkIsBirthday() ? 'birthday.png' : 'normal.png';
            const stateIcon = isForcedSleep ? 'sleep.png' : baseIcon;

            // 트레이 아이콘 변경
            const iconPath = path.join(__dirname, 'assets', appConfig.character, stateIcon);

            tray.setImage(createTrayIcon(iconPath));

            // 펫 윈도우 이미지 변경
            if (petWindow) {
                const relativePath = `assets/${appConfig.character}/${stateIcon}`;
                petWindow.webContents.send('update-image', relativePath);
            }

            // 깨어있는 상태라면, 잠시 후 실제 상태(배고픔 등)로 다시 한 번 업데이트
            if (!isForcedSleep) {
                // 즉시 반영 후 자연스럽게 상태 체크로 넘어감
                checkSystemStatus();
            }
        }
    });

    // 1. 드래그 시작
    ipcMain.on('drag-start', () => {
        if (!petWindow || petWindow.isDestroyed()) return;

        try {
            const cursor = screen.getCursorScreenPoint();
            const winBounds = petWindow.getBounds();

            const offsetX = cursor.x - winBounds.x;
            const offsetY = cursor.y - winBounds.y;
            const fixedWidth = winBounds.width;
            const fixedHeight = winBounds.height;

            if (dragInterval) clearInterval(dragInterval);

            // 16ms (약 60fps) 간격
            dragInterval = setInterval(() => {
                try {
                    if (!petWindow || petWindow.isDestroyed()) {
                        clearInterval(dragInterval);
                        return;
                    }

                    const newCursor = screen.getCursorScreenPoint();
                    const newX = newCursor.x - offsetX;
                    const newY = newCursor.y - offsetY;

                    // 1. 펫 이동 (크기 고정)
                    petWindow.setBounds({
                        x: newX,
                        y: newY,
                        width: fixedWidth,
                        height: fixedHeight
                    });

                    // 2. 말풍선 이동
                    if (bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible()) {
                        const bubbleBounds = bubbleWindow.getBounds();

                        // ★ [핵심] "지금 펫 어디 있어?"(getBounds) 라고 묻지 말고
                        // "펫은 방금 newX, newY로 갔어!" 라고 직접 알려줍니다.
                        // 이렇게 하면 시차가 0이 됩니다.
                        const simulatedPetBounds = {
                            x: newX,
                            y: newY,
                            width: fixedWidth,
                            height: fixedHeight
                        };

                        // 수정된 함수에 가짜 위치(simulatedPetBounds)를 넣어줌
                        const { x: bx, y: by } = getBubblePosition(bubbleBounds.width, bubbleBounds.height, simulatedPetBounds);

                        bubbleWindow.setPosition(bx, by, false);
                        bubbleWindow.setAlwaysOnTop(true, 'screen-saver');
                    }
                } catch (e) {
                    // 드래그 중 에러 무시
                }
            }, 16);

        } catch (error) {
            console.log("드래그 시작 실패:", error);
        }
    });

    // 3. 드래그 끝
    ipcMain.on('drag-end', () => {
        if (dragInterval) {
            clearInterval(dragInterval);
            dragInterval = null;
        }

        // ★ [추가] 드래그가 끝나는 순간, 말풍선 위치를 한 번 더 완벽하게 맞춤 (자석 효과)
        if (petWindow && bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible()) {
            const bubbleBounds = bubbleWindow.getBounds();
            const { x, y } = getBubblePosition(bubbleBounds.width, bubbleBounds.height);

            // 애니메이션 없이 즉시 이동
            bubbleWindow.setPosition(x, y, false);
        }
    });
});

// ★ [Mac 수정] 트레이 아이콘 크기 최적화 함수
function createTrayIcon(imagePath) {
    let image = nativeImage.createFromPath(imagePath);
    // Mac은 트레이 아이콘이 너무 크면 상단바가 깨짐. 22x22 정도로 리사이징 필요
    if (isMac) {
        image = image.resize({ width: 22, height: 22 });
    } else {
        // [Windows] 원본이 너무 크면 트레이에 안 뜰 수 있으므로 32x32로 리사이징
        image = image.resize({ width: 32, height: 32 });
    }
    return image;
}

// ★ [Mac 수정] 설정창에서 Cmd+C, Cmd+V 사용을 위한 기본 메뉴
function createMacMenu() {
    const template = [
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
                { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getBubblePosition(bubbleWidth, bubbleHeight, customPetBounds = null) {
    let x = 0, y = 0;

    // 1. 펫이 켜져 있을 때
    if (appConfig.showPet && petWindow && !petWindow.isDestroyed()) {
        const petBounds = customPetBounds || petWindow.getBounds();
        const yOffset = 20; // 펫 머리 위 간격

        // ★ [가로] 무조건 펫의 정중앙 (화면 밖으로 나가도 상관 안 함)
        x = Math.round(petBounds.x + (petBounds.width / 2) - (bubbleWidth / 2));

        // ★ [세로] 무조건 머리 위 (화면 밖으로 나가도 상관 안 함)
        y = Math.round(petBounds.y - bubbleHeight - yOffset);

        // ※ screenX, screenY 검사 코드 전부 삭제함! (자유롭게 이동 가능)

        // 2. 펫이 꺼져 있을 때 (트레이 아이콘 기준)
    } else if (tray) {
        const trayBounds = tray.getBounds();
        const yOffset = 10;

        // 트레이 아이콘 중앙
        x = Math.round(trayBounds.x + (trayBounds.width / 2) - (bubbleWidth / 2));

        if (isMac) {
            // [Mac 수정] 트레이 아이콘 바로 밑에 붙도록 간격 줄임 (10 -> 2)
            y = Math.round(trayBounds.y + trayBounds.height + 2);
        } else {
            y = Math.round(trayBounds.y - bubbleHeight - yOffset);
        }
        // (트레이 쪽은 원래 고정이라 별도의 충돌 방지가 없어도 괜찮습니다)
    }

    return { x, y };
}

function createPetWindow() {
    // [Mac 수정] workArea를 사용하여 상단 메뉴바/하단 독을 제외한 영역 계산
    const display = screen.getPrimaryDisplay();
    const { width, height, x: workX, y: workY } = display.workArea; // workX, workY는 작업영역 시작점

    petWindow = new BrowserWindow({
        width: 120, height: 120,
        // [Mac 수정] 좌표 계산 시 workX, workY를 더해줘야 정확한 위치에 뜸
        x: workX + width - 160,
        y: workY + height - 160,
        transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, focusable: false,
        show: appConfig.showPet,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    // [Mac 수정] Mac에서 'alwaysOnTop'이 풀리는 경우 방지 (선택사항)
    if (isMac) {
        petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    petWindow.loadFile('pet.html');

    // 초기 이미지 로드 (조금 뒤에 실행해야 로딩됨)
    petWindow.webContents.on('did-finish-load', () => {
        const startIcon = checkIsBirthday() ? 'birthday.png' : 'normal.png';
        const relativePath = `assets/${appConfig.character}/${startIcon}`;
        petWindow.webContents.send('update-image', relativePath);
    });
}

// --- [NEW] 메뉴를 동적으로 바꾸는 함수 ---
function updateContextMenu() {
    const contextMenu = Menu.buildFromTemplate([
        {
            // 클릭할 때마다 '재우기' <-> '깨우기' 글자가 바뀜
            label: isForcedSleep ? '🌞 깨우기' : '💤 재우기',
            type: 'normal',
            click: toggleSleepMode
        },
        { type: 'separator' },
        { label: '� 오늘의 운세', type: 'normal', click: askDailyFortune }, // [MOD] 메뉴 및 고민해결 삭제
        { type: 'separator' },
        { label: '환경 설정...', type: 'normal', click: openSettingsWindow },
        { type: 'separator' },
        { label: '종료', type: 'normal', click: () => app.quit() }
    ]);
    tray.setContextMenu(contextMenu);
}

// --- 1. 오늘의 운세 ---
function askDailyFortune() {
    wakeUpIfSleeping();

    const fortunes = [
        "오늘은 뜻밖의 행운이 찾아올 거예요! 🍀\n복권을 사보시는 건 어때요?",
        "신중함이 필요한 하루입니다.\n작은 실수도 조심하면 좋은 결과가 있을 거예요.",
        "오래된 친구에게 연락이 올 수도 있어요.\n반갑게 맞이해주세요! 👋",
        "오늘은 열정이 넘치는 날! 🔥\n미뤄뒀던 일을 시작하기 딱 좋습니다.",
        "조금 지칠 수 있는 날이에요.\n달콤한 간식으로 기분을 전환해보세요! 🍫",
        "금전운이 아주 좋아요! 💰\n하지만 과소비는 금물입니다.",
        "사랑운이 가득한 하루! 💕\n주변 사람들에게 친절을 베풀어보세요."
    ];

    const pick = fortunes[Math.floor(Math.random() * fortunes.length)];
    showBubbleMessage('오늘의 운세 📅', pick, 'cool.png');
}

// [삭제됨] 메뉴 추천 & 고민 해결 기능

// --- 공통 헬퍼 함수들 ---
function wakeUpIfSleeping() {
    if (isForcedSleep) {
        toggleSleepMode();
    }
}

function showBubbleMessage(title, content, iconName) {
    if (bubbleWindow && !bubbleWindow.isDestroyed()) {
        const tailPosition = (isMac && !appConfig.showPet) ? 'top' : 'bottom';
        const soundPath = path.join(__dirname, 'assets', appConfig.character, 'sound.mp3');

        bubbleWindow.webContents.send('update-message', {
            title: title,
            content: content,
            soundVolume: appConfig.soundVolume,
            isNewPopup: true,
            emotion: iconName,
            tailPosition: tailPosition,
            soundPath: soundPath
        });
        showBubble();
    }
}

// --- [NEW] 수면 모드 토글 함수 ---
function toggleSleepMode() {
    try {
        isForcedSleep = !isForcedSleep;
        updateContextMenu();

        const stateIcon = isForcedSleep ? 'sleep.png' : 'normal.png';
        const iconPath = path.join(__dirname, 'assets', appConfig.character, stateIcon);

        // 트레이 아이콘 변경
        tray.setImage(createTrayIcon(iconPath));

        // 펫 윈도우 이미지 변경 (창이 살아있을 때만!)
        if (petWindow && !petWindow.isDestroyed()) {
            const relativePath = `assets/${appConfig.character}/${stateIcon}`;
            petWindow.webContents.send('update-image', relativePath);
        }

        if (isForcedSleep) {
            if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.hide();
            tray.setToolTip('Zzz...');
        } else {
            // 깨울 때는 상태 체크 시작
            checkSystemStatus();
        }
    } catch (error) {
        console.error("재우기 모드 전환 중 에러:", error);
    }
}

// --- 설정 창 열기 함수 ---
function openSettingsWindow() {
    if (settingsWindow) { settingsWindow.focus(); return; }
    settingsWindow = new BrowserWindow({
        width: 400, height: 700, title: '환경 설정', autoHideMenuBar: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    settingsWindow.loadFile('settings.html');
    settingsWindow.webContents.on('did-finish-load', () => {
        settingsWindow.webContents.send('init-settings', appConfig);
    });
    settingsWindow.on('closed', () => { settingsWindow = null; });
}

function createBubbleWindow() {
    bubbleWindow = new BrowserWindow({
        width: 200, height: 100, show: false, frame: false, transparent: true,
        alwaysOnTop: true, skipTaskbar: true, resizable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    bubbleWindow.loadFile('bubble.html');

    // [Mac 수정] Mac에서 'alwaysOnTop'이 풀리는 경우 방지 및 스페이스 이동 시 따라오기
    if (isMac) {
        // 펫이 보일 때만 모든 워크스페이스에서 보임
        bubbleWindow.setVisibleOnAllWorkspaces(appConfig.showPet, { visibleOnFullScreen: true });
    }
}

function toggleBubble() {
    if (bubbleWindow.isVisible()) bubbleWindow.hide();
    else showBubble();
}

function showBubble() {
    if (!bubbleWindow || bubbleWindow.isDestroyed()) return;

    const bounds = bubbleWindow.getBounds();
    const { x, y } = getBubblePosition(bounds.width, bounds.height);

    bubbleWindow.setPosition(x, y, false); // 애니메이션 없이 즉시 이동

    // [NEW] 보일 때마다 꼬리 방향 확실하게 업데이트
    const tailPosition = (isMac && !appConfig.showPet) ? 'top' : 'bottom';
    bubbleWindow.webContents.send('update-tail', tailPosition);

    // 순서 중요: 보이기 -> 맨 위로 올리기 -> 포커스
    bubbleWindow.showInactive(); // show() 대신 showInactive()가 부드러울 때가 있음
    bubbleWindow.setAlwaysOnTop(true, 'screen-saver'); // 최상위 강제 설정
    bubbleWindow.focus();
}

function startStatusCheck() {
    if (statusCheckInterval) clearInterval(statusCheckInterval);
    checkSystemStatus();
    statusCheckInterval = setInterval(checkSystemStatus, appConfig.interval);
}

async function checkSystemStatus() {
    if (isForcedSleep) return;

    try {
        const [battery, wifi, volume, muted, cpu] = await Promise.all([
            si.battery(),
            si.wifiConnections(),
            loudness.getVolume(),
            loudness.getMuted(),
            si.cpuTemperature()
        ]);

        const temp = cpu.main || 0;
        let candidates = [];

        // --- [상황별 후보 추가] ---

        // 1. 와이파이 끊김
        if (!wifi[0] || wifi[0].quality < 50) {
            candidates.push({
                icon: 'wifi_bad.png',
                title: '인터넷 끊김! 📡',
                content: !wifi[0] ? '외로워요...' : `신호 약함 (${wifi[0].quality}%)`,
                shouldShow: true
            });
        }

        // 2. CPU 과열
        if (temp >= 60) {
            candidates.push({
                icon: 'hot.png',
                title: '앗 뜨거! 🔥',
                content: `CPU가 ${temp}도에요! 열나요!`,
                shouldShow: true
            });
        }

        // 3. 배고픔 (배터리 부족)
        if (battery.percent <= 20 && !battery.isCharging) {
            candidates.push({
                icon: 'hungry.png',
                title: '배고파요 😭',
                content: `배터리 ${battery.percent}% 남았어요.. 밥 주세요..`,
                shouldShow: true
            });
        }

        // 4. 시끄러움
        if (volume > 80 && !muted) {
            candidates.push({
                icon: 'noisy.png',
                title: '너무 시끄러워요! 🔊',
                content: `볼륨 ${volume}%... 귀 터지겠어요!`,
                shouldShow: true
            });
        }

        // 5. 음소거 상태
        if (muted || volume === 0) {
            candidates.push({
                icon: 'mute.png',
                title: '쉿! 🤫',
                content: '조용히 있을게요...',
                shouldShow: true
            });
        }

        // 6. CPU 시원함
        if (temp > 0 && temp < 45) {
            candidates.push({
                icon: 'cool.png',
                title: '아 시원해 ❄️',
                content: `온도 ${temp}도. 아주 쾌적해요!`,
                shouldShow: true
            });
        }

        // 7. 배부름 (충전 완료)
        if (battery.percent >= 90) {
            candidates.push({
                icon: 'full.png',
                title: '기분 최고! 😆',
                content: `에너지 ${battery.percent}%! 날아갈 것 같아요.`,
                shouldShow: true
            });
        }

        // 8. 와이파이 원활
        if (wifi[0].quality >= 80) {
            candidates.push({
                icon: 'wifi_good.png',
                title: '인터넷 빨라요! 📡',
                content: '친구들 만나러 가요!!',
                shouldShow: true
            });
        }

        // --- [기본 후보] 평범한 상태 정보 ---
        // --- [기본 후보] 평범한 상태 정보 ---

        // 1. 기본 상태 (Normal)은 항상 후보에 포함
        candidates.push({
            icon: 'normal.png',
            title: '현재상태 👍',
            content: `배터리 ${battery.percent}%, 온도 ${temp}도`,
            shouldShow: true
        });

        // 2. 생일이면 생일 축하 메시지도 후보에 추가 (랜덤으로 뜸)
        if (checkIsBirthday()) {
            candidates.push({
                icon: 'birthday.png',
                title: '생일 축하해요! 🎂',
                content: `오늘 하루 행복하세요! (배터리 ${battery.percent}%)`,
                shouldShow: true
            });
        }


        const pick = candidates[Math.floor(Math.random() * candidates.length)];

        const absPath = path.join(__dirname, 'assets', appConfig.character, pick.icon);
        // [Mac 수정] 이미지 변경 시 리사이징 적용
        tray.setImage(createTrayIcon(absPath));

        // 2. 펫 윈도우 이미지 (file:// URL 사용)
        if (petWindow) {
            const relativePath = `assets/${appConfig.character}/${pick.icon}`;
            petWindow.webContents.send('update-image', relativePath);
        }
        if (bubbleWindow) {
            // 수정: 말풍선을 띄워야 하는 상황이면 무조건 소리 내기
            const isNewPopup = pick.shouldShow;
            const rawText = pick.title;
            const cleanText = rawText.replace(/[^가-힣a-zA-Z0-9\s.,?!%]/g, '');

            // 말풍선 꼬리 방향 결정 (Mac이고 펫이 숨겨져서 트레이에 붙을 때만 'top')
            const tailPosition = (isMac && !appConfig.showPet) ? 'top' : 'bottom';

            // 효과음 경로 (각 캐릭터 폴더의 sound.mp3)
            const soundPath = path.join(__dirname, 'assets', appConfig.character, 'sound.mp3');

            bubbleWindow.webContents.send('update-message', {
                title: pick.title,
                content: pick.content,
                soundVolume: appConfig.soundVolume,
                isNewPopup: isNewPopup,
                emotion: pick.icon,
                tailPosition: tailPosition,
                soundPath: soundPath
            });
        }

        // 말풍선 띄우기
        if (pick.shouldShow && !bubbleWindow.isVisible()) {
            showBubble();
        }

    } catch (error) {
        console.error('시스템 정보 읽기 실패:', error);
    }
}

// ★ [추가] 오늘이 생일인지 확인하는 함수
function checkIsBirthday() {
    if (!appConfig.birthday || appConfig.birthday.month === 0) return false;

    const now = new Date();
    const currentMonth = now.getMonth() + 1; // 월은 0부터 시작해서 +1
    const currentDay = now.getDate();

    return appConfig.birthday.month === currentMonth &&
        appConfig.birthday.day === currentDay;
}