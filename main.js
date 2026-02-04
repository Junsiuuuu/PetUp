const { app, Tray, Menu, nativeImage, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const si = require('systeminformation');
const loudness = require('loudness');

const isMac = process.platform === 'darwin';
// ★ [필수] 사용자 클릭 없이도 TTS/소리 재생 허용
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let tray = null;
let bubbleWindow = null;
let petWindow = null;
let settingsWindow = null; // 설정 창 변수
let statusCheckInterval = null;

// --- [전역 설정 변수] ---
let appConfig = {
    interval: 30000,   // 기본 5초
    soundVolume: 50,   // 기본 볼륨 50%
    character: 'pig',
    showPet: true,
    birthday: { month: 0, day: 0 }
};

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
        }

        // 2. ★ [핵심] 캐릭터가 바뀌었으면 "즉시" 이미지 교체 (기다리지 않음)
        if (charChanged) {
            // 현재 자는 중이면 sleep.png, 아니면 normal.png를 바로 보여줌
            const stateIcon = isForcedSleep ? 'sleep.png' : 'normal.png';
            
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
                checkSystemStatus();
            }
        }

        // ★ 캐릭터나 생일이 바뀌면 이미지 즉시 업데이트
        if (charChanged || birthdayChanged) {
             // 자는 중이 아니면 즉시 상태 체크(생일이면 모자 씀)
            if (!isForcedSleep) checkSystemStatus();
        }
    });
});

// ★ [Mac 수정] 트레이 아이콘 크기 최적화 함수
function createTrayIcon(imagePath) {
    let image = nativeImage.createFromPath(imagePath);
    // Mac은 트레이 아이콘이 너무 크면 상단바가 깨짐. 22x22 정도로 리사이징 필요
    if (isMac) {
        image = image.resize({ width: 22, height: 22 });
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

function getBubblePosition(bubbleWidth, bubbleHeight) {
    let x = 0, y = 0;

    // 펫 윈도우가 살아있고, 보여지는 상태라면
    if (appConfig.showPet && petWindow && !petWindow.isDestroyed() && petWindow.isVisible()) {
        const petBounds = petWindow.getBounds();
        const yOffset = 20; 

        x = Math.round(petBounds.x + (petBounds.width / 2) - (bubbleWidth / 2));
        y = Math.round(petBounds.y - bubbleHeight - yOffset);
    
    } else if (tray) {
        const trayBounds = tray.getBounds();
        const yOffset = 10; 

        x = Math.round(trayBounds.x + (trayBounds.width / 2) - (bubbleWidth / 2));
        
        if (isMac) {
            y = Math.round(trayBounds.y + trayBounds.height + yOffset); 
        } else {
            y = Math.round(trayBounds.y - bubbleHeight - yOffset);
        }
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

    petWindow.on('move', () => {
        try {
            // 1. 말풍선 윈도우가 없거나 죽었으면(destroyed) 무시
            if (!bubbleWindow || bubbleWindow.isDestroyed()) return;
            
            // 2. 말풍선이 보여질 때만 따라다님
            if (bubbleWindow.isVisible()) {
                const bubbleBounds = bubbleWindow.getBounds();
                
                // 3. 펫 위치 기준으로 말풍선 위치 계산
                const { x, y } = getBubblePosition(bubbleBounds.width, bubbleBounds.height);
                
                // 4. 위치 적용 (에러 발생 시 catch로 이동)
                bubbleWindow.setPosition(x, y);
            }
        } catch (error) {
            // 이동 중 에러가 나면 무시함 (드래그가 너무 빠를 때 발생 가능)
            // console.log('이동 중 경미한 에러 무시:', error.message);
        }
    });

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
        { label: '환경 설정...', type: 'normal', click: openSettingsWindow },
        { type: 'separator' },
        { label: '종료', type: 'normal', click: () => app.quit() }
    ]);
    tray.setContextMenu(contextMenu);
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
}

function toggleBubble() {
    if (bubbleWindow.isVisible()) bubbleWindow.hide();
    else showBubble();
}

function showBubble() {
    if (!petWindow) return;

    const petBounds = petWindow.getBounds();
    const bubbleBounds = bubbleWindow.getBounds();
    const yOffset = 20;

    const x = Math.round(petBounds.x + (petBounds.width / 2) - (bubbleBounds.width / 2));
    const y = Math.round(petBounds.y - bubbleBounds.height - yOffset);
    
    bubbleWindow.setPosition(x, y, false);
    bubbleWindow.show();
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
        if (checkIsBirthday()) {
            candidates.push({
                icon: 'birthday.png',
                title: '생일 축하해요! 🎂',
                content: `오늘 하루 행복하세요! (배터리 ${battery.percent}%)`,
                shouldShow: true
            });
        } else {
            // 생일이 아니면 원래대로 normal.png 사용
            candidates.push({
                icon: 'normal.png',
                title: '현재상태 👍',
                content: `배터리 ${battery.percent}%, 온도 ${temp}도`,
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

            bubbleWindow.webContents.send('update-message', {
                title: pick.title,
                content: pick.content,
                soundVolume: appConfig.soundVolume,
                isNewPopup: isNewPopup,
                emotion: pick.icon,
                ttsText: cleanText
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