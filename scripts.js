// --- STATE MANAGEMENT ---
let cards = JSON.parse(localStorage.getItem('flashdeck_v3_cards')) || [];
let userCredits = parseInt(localStorage.getItem('flashdeck_v3_credits')) || 100;
let lastLogin = localStorage.getItem('flashdeck_v3_login');

// Runtime State
let reviewQueue = [];
let currentCard = null;
let editingId = null; 
let isCramSession = false;
let cramConfig = { tag: 'ALL', type: 'MIX' }; // Stores cram filter choices

// Game State
let gameQueue = [];
let gameRound = 1;
let gameSpeed = 3000;
let gameTimer = null;
let gamePhase = 'WATCH';
let gameIndex = 0;
let gameScore = 0;

// --- DOM ELEMENTS ---
const views = {
    dashboard: document.getElementById('view-dashboard'),
    add: document.getElementById('view-add'),
    review: document.getElementById('view-review'),
    game: document.getElementById('view-game'),
    settings: document.getElementById('view-settings')
};

function init() {
    checkDailyBonus();
    updateDashboard();
    setupEventListeners();
    refreshTagList();
}

// --- CURRENCY LOGIC ---
function checkDailyBonus() {
    const today = new Date().toDateString();
    if (lastLogin !== today) {
        userCredits += 50; 
        alert("Daily Bonus! +50 ⚡");
        localStorage.setItem('flashdeck_v3_login', today);
        saveCredits();
    }
}

function saveCredits() {
    localStorage.setItem('flashdeck_v3_credits', userCredits);
    document.getElementById('credit-count').textContent = userCredits;
    updateDashboardButtons();
}

function updateDashboardButtons() {
    const btn = document.getElementById('btn-action-main');
    const isCram = btn.classList.contains('cram-btn');
    
    if (isCram) {
        if (userCredits < 50) {
            btn.disabled = true;
            btn.innerHTML = `Configure Cram (50 ⚡)<br><small>Not enough sparks</small>`;
        } else {
            btn.disabled = false;
            btn.innerHTML = `Configure Cram <span class="cost-tag">-50 ⚡</span>`;
        }
    }
}

// --- HELPER: CJK DETECTION ---
function isCJK(text) {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/.test(text);
}

// --- HELPER: FISHER-YATES SHUFFLE ---
function shuffle(array) {
    let currentIndex = array.length, randomIndex;
    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
}

// --- DASHBOARD & LIST ---
function updateDashboard() {
    const now = Date.now();
    const due = cards.filter(c => c.dueDate <= now);
    const box = document.querySelector('.stats-box');
    const btn = document.getElementById('btn-action-main');
    const heading = document.getElementById('status-heading');

    document.getElementById('credit-count').textContent = userCredits;

    if (due.length > 0) {
        // SRS Mode (Unified)
        box.classList.remove('cram-mode');
        heading.textContent = "Due Today";
        document.getElementById('due-count').textContent = due.length;
        btn.textContent = `Review Now (${due.length})`;
        btn.classList.remove('cram-btn');
        btn.disabled = false;
        btn.onclick = startSRSReview;
    } else {
        // Cram Mode (Requires Config)
        box.classList.add('cram-mode');
        heading.textContent = "All Caught Up!";
        document.getElementById('due-count').textContent = "0";
        btn.classList.add('cram-btn');
        btn.onclick = openCramModal; // Opens the config modal
    }
    
    updateDashboardButtons();

    document.getElementById('total-count').textContent = `${cards.length} cards`;

    // Render List
    const list = document.getElementById('card-list');
    list.innerHTML = '';
    cards.forEach(card => {
        const div = document.createElement('div');
        div.className = 'card-item';
        const isChinese = isCJK(card.target);
        div.innerHTML = `
            <div class="card-text">
                <div>
                    ${card.tag ? `<span class="tag">${card.tag}</span>` : ''}
                    <span style="font-weight:bold; font-size: ${isChinese ? '1.1rem' : '1rem'}">${card.target.substring(0, 20)}</span>
                </div>
                ${card.meta ? `<span class="meta-text">${card.meta}</span>` : ''}
                <span style="color:#666; font-size:0.8rem;">${card.native.substring(0, 20)}</span>
            </div>
            <div class="card-actions">
                <button class="action-btn" onclick="editCard(${card.id})">✎</button>
                <button class="action-btn" onclick="deleteCard(${card.id})">🗑</button>
            </div>
        `;
        list.appendChild(div);
    });
    
    refreshTagList();
}

function refreshTagList() {
    const uniqueTags = [...new Set(cards.map(c => c.tag).filter(t => t))];
    const datalist = document.getElementById('tag-list');
    datalist.innerHTML = '';
    uniqueTags.forEach(tag => {
        const opt = document.createElement('option');
        opt.value = tag;
        datalist.appendChild(opt);
    });

    // Populate Cram Select
    const select = document.getElementById('cram-tag-select');
    // Keep "All Tags"
    select.innerHTML = '<option value="ALL">All Tags</option>'; 
    uniqueTags.forEach(tag => {
        const opt = document.createElement('option');
        opt.value = tag;
        opt.textContent = tag;
        select.appendChild(opt);
    });
}

// --- NAVIGATION ---
function showView(viewName) {
    Object.values(views).forEach(el => {
        el.classList.remove('active-view');
        el.classList.add('hidden-view');
    });
    views[viewName].classList.remove('hidden-view');
    views[viewName].classList.add('active-view');
    if(viewName === 'dashboard') updateDashboard();
}

// --- ADD / EDIT / IMPORT ---
let addType = 'VOCAB';

function updateInputLabels() {
    const targetVal = document.getElementById('input-target').value;
    const metaLabel = document.getElementById('label-meta');
    if (isCJK(targetVal)) {
        metaLabel.textContent = "Pinyin / Reading (Recommended)";
    } else {
        metaLabel.textContent = "Notes / Gender (Optional)";
    }
}

function saveCard(e) {
    e.preventDefault();
    const target = document.getElementById('input-target').value;
    const meta = document.getElementById('input-meta').value;
    const native = document.getElementById('input-native').value;
    const tag = document.getElementById('input-tag').value.trim();

    const payload = {
        id: editingId || Date.now(),
        type: addType,
        target: target,
        meta: meta,
        native: native,
        tag: tag,
        dueDate: editingId ? (cards.find(c=>c.id === editingId).dueDate) : Date.now(),
        interval: editingId ? (cards.find(c=>c.id === editingId).interval) : 0,
        factor: editingId ? (cards.find(c=>c.id === editingId).factor) : 2.5
    };

    if (editingId) {
        const index = cards.findIndex(c => c.id === editingId);
        if (index > -1) cards[index] = payload;
        editingId = null;
        document.getElementById('add-title').textContent = "New Card";
    } else {
        cards.push(payload);
    }
    saveData();
    document.getElementById('add-form').reset();
    showView('dashboard');
}

function runBulkImport() {
    const raw = document.getElementById('input-bulk').value;
    const bulkTag = document.getElementById('input-bulk-tag').value.trim();
    if (!raw.trim()) return;

    const lines = raw.split('\n');
    let count = 0;
    const useTab = raw.indexOf('\t') !== -1;
    const delimiter = useTab ? '\t' : ',';

    lines.forEach(line => {
        if (!line.trim()) return;
        let parts = line.split(delimiter).map(s => s.trim());
        if (parts.length < 2) return;
        if (parts[0].toLowerCase() === 'target' || parts[0].toLowerCase() === 'front') return;

        let target, meta, native;
        if (parts.length === 2) {
            target = parts[0]; native = parts[1]; meta = "";
        } else {
            target = parts[0]; meta = parts[1]; native = parts[2];
        }

        // SMART TYPE DETECTION
        let type = 'VOCAB';
        if (isCJK(target)) {
            // If punctuation found, assume sentence
            if (/[。？！，,?!]/.test(target)) type = 'SENTENCE';
        } else {
            // If > 3 words, assume sentence
            if (target.split(' ').length > 3) type = 'SENTENCE';
        }

        cards.push({
            id: Date.now() + Math.random(),
            type: type, 
            target: target,
            meta: meta,
            native: native,
            tag: bulkTag, // Apply the bulk tag
            dueDate: Date.now(),
            interval: 0,
            factor: 2.5
        });
        count++;
    });

    saveData();
    document.getElementById('input-bulk').value = "";
    document.getElementById('modal-import').classList.add('hidden');
    alert(`Imported ${count} cards!`);
    showView('dashboard');
}

function editCard(id) {
    const card = cards.find(c => c.id === id);
    if(!card) return;
    editingId = id; 
    document.getElementById('input-target').value = card.target;
    document.getElementById('input-meta').value = card.meta;
    document.getElementById('input-native').value = card.native;
    document.getElementById('input-tag').value = card.tag || "";
    updateInputLabels();
    if(card.type === 'VOCAB') document.getElementById('type-vocab').click();
    else document.getElementById('type-sentence').click();
    document.getElementById('add-title').textContent = "Edit Card";
    showView('add');
}

function deleteCard(id) {
    if(confirm("Delete this card?")) {
        cards = cards.filter(c => c.id !== id);
        saveData();
    }
}

function saveData() {
    localStorage.setItem('flashdeck_v3_cards', JSON.stringify(cards));
    updateDashboard();
}

// --- CRAM MODAL LOGIC ---
function openCramModal() {
    document.getElementById('modal-cram-settings').classList.remove('hidden');
}

function runCramSession() {
    if(userCredits < 50) return alert("Not enough sparks!");
    
    // 1. Get Filters
    const tagFilter = document.getElementById('cram-tag-select').value;
    const typeBtn = document.querySelector('#modal-cram-settings .toggle-btn.active').id;
    let typeFilter = 'MIX';
    if (typeBtn.includes('vocab')) typeFilter = 'VOCAB';
    if (typeBtn.includes('sentence')) typeFilter = 'SENTENCE';

    // 2. Filter Pool
    let pool = cards;
    if (tagFilter !== 'ALL') pool = pool.filter(c => c.tag === tagFilter);
    if (typeFilter !== 'MIX') pool = pool.filter(c => c.type === typeFilter);

    if (pool.length === 0) return alert("No cards match filters!");

    // 3. Spend & Start
    userCredits -= 50;
    saveCredits();
    document.getElementById('modal-cram-settings').classList.add('hidden');

    isCramSession = true;
    reviewQueue = shuffle([...pool]).slice(0, 10);
    document.getElementById('mode-indicator').textContent = "Cram Mode";
    document.getElementById('mode-indicator').style.background = "#e17055";
    showView('review');
    loadNextReviewCard();
}

// --- REVIEW ENGINE ---
function startSRSReview() {
    isCramSession = false;
    const now = Date.now();
    reviewQueue = cards.filter(c => c.dueDate <= now);
    document.getElementById('mode-indicator').textContent = "SRS Review";
    document.getElementById('mode-indicator').style.background = "#4a90e2";
    showView('review');
    loadNextReviewCard();
}

function loadNextReviewCard() {
    if(reviewQueue.length === 0) {
        alert(isCramSession ? "Cram Complete!" : "Reviews Complete!");
        showView('dashboard');
        return;
    }
    currentCard = reviewQueue[0];
    
    // UI Reset
    document.getElementById('card-answer').classList.add('hidden');
    document.getElementById('cloze-input-area').classList.add('hidden');
    document.getElementById('cloze-answer').value = '';
    document.getElementById('cloze-answer').className = '';
    document.getElementById('review-sub-text').classList.add('hidden');
    document.getElementById('btn-show-hint').classList.add('hidden');
    document.getElementById('progress-text').textContent = `${reviewQueue.length} left`;

    // Show Tag Badge
    const badge = document.getElementById('review-tag-badge');
    if (currentCard.tag) {
        badge.textContent = currentCard.tag;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }

    if (currentCard.type === 'SENTENCE') {
        renderClozeCard();
    } else {
        if (Math.random() > 0.3) renderVocabRecognition();
        else renderVocabRecall();
    }
}

function renderVocabRecognition() {
    document.getElementById('review-hint-label').textContent = "Translate to Native:";
    document.getElementById('review-main-text').textContent = currentCard.target;
    setupAnswerDisplay();
}

function renderVocabRecall() {
    document.getElementById('review-hint-label').textContent = "Translate to Target:";
    document.getElementById('review-main-text').textContent = currentCard.native;
    if (currentCard.meta) {
        const btn = document.getElementById('btn-show-hint');
        btn.classList.remove('hidden');
        btn.onclick = (e) => {
            e.stopPropagation();
            document.getElementById('review-sub-text').textContent = currentCard.meta;
            document.getElementById('review-sub-text').classList.remove('hidden');
            btn.classList.add('hidden');
        };
    }
    setupAnswerDisplay();
}

function setupAnswerDisplay() {
    document.getElementById('review-answer-target').textContent = currentCard.target;
    document.getElementById('review-answer-meta').textContent = currentCard.meta || "";
    document.getElementById('review-answer-native').textContent = currentCard.native;
    document.getElementById('card-question').onclick = revealAnswer;
    document.getElementById('card-question').style.cursor = 'pointer';
}

function renderClozeCard() {
    document.getElementById('review-hint-label').textContent = currentCard.native; 
    document.getElementById('card-question').onclick = null; 
    document.getElementById('card-question').style.cursor = 'default';

    const isChinese = isCJK(currentCard.target);
    let words = [], candidates = [];

    if (isChinese) {
        words = currentCard.target.split(''); 
        candidates = words.map((w, i) => ({word: w, index: i})).filter(item => !/[ ，。？！?!\.,]/.test(item.word));
    } else {
        words = currentCard.target.split(' ');
        candidates = words.map((w, i) => ({word: w, index: i})).filter(item => item.word.length > 2);
    }

    if(candidates.length === 0) { renderVocabRecognition(); return; }

    const selected = candidates[Math.floor(Math.random() * candidates.length)];
    window.clozeAnswer = selected.word;
    
    const displayWords = [...words];
    displayWords[selected.index] = "___";
    
    const joiner = isChinese ? '' : ' ';
    document.getElementById('review-main-text').textContent = displayWords.join(joiner);
    
    document.getElementById('review-answer-target').textContent = currentCard.target;
    document.getElementById('review-answer-meta').textContent = currentCard.meta;
    document.getElementById('review-answer-native').textContent = currentCard.native;

    document.getElementById('cloze-input-area').classList.remove('hidden');
    document.getElementById('cloze-answer').focus();
}

function checkCloze() {
    const input = document.getElementById('cloze-answer');
    const userVal = input.value.trim().toLowerCase();
    const correctVal = window.clozeAnswer.toLowerCase();

    if(userVal === correctVal) {
        input.classList.add('input-correct');
        setTimeout(revealAnswer, 600);
    } else {
        input.classList.add('input-wrong');
        setTimeout(revealAnswer, 1500); 
    }
}

function revealAnswer() {
    document.getElementById('card-answer').classList.remove('hidden');
    document.getElementById('card-question').onclick = null;
}

function handleRating(rating) {
    if (!isCramSession) {
        if (rating === 0) {
            currentCard.interval = 0;
            currentCard.dueDate = Date.now();
        } else {
            if (currentCard.interval === 0) currentCard.interval = 1;
            const multipliers = [0, 1.2, 2.5, 4.0];
            currentCard.interval = Math.ceil(currentCard.interval * multipliers[rating]);
            currentCard.dueDate = Date.now() + (currentCard.interval * 24 * 60 * 60 * 1000);
        }
        saveData();
    }
    reviewQueue.shift();
    loadNextReviewCard();
}

// --- GAME ENGINE (Infinite Speed) ---
function startGame() {
    if (cards.length < 5) return alert("Add at least 5 cards!");
    gameRound = 1;
    startRound();
}

function startRound() {
    gameQueue = shuffle([...cards]).slice(0, 10);
    // Infinite Decay: 3000 * 0.8^(r-1), floor 250
    let calcSpeed = 3000 * Math.pow(0.8, gameRound - 1);
    gameSpeed = Math.floor(Math.max(250, calcSpeed));
    startWatchPhase();
}

function startWatchPhase() {
    gamePhase = 'WATCH';
    gameIndex = 0;
    showView('game');
    document.getElementById('game-status').textContent = `Round ${gameRound} (Speed: ${gameSpeed}ms)`;
    document.getElementById('game-input-area').classList.add('hidden');
    playNextWatchCard();
}

function playNextWatchCard() {
    if (gameIndex >= gameQueue.length) {
        startTestPhase();
        return;
    }
    const card = gameQueue[gameIndex];
    
    // Game Tag Badge
    const badge = document.getElementById('game-tag-badge');
    if (card.tag) {
        badge.textContent = card.tag;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }

    document.getElementById('game-card-content').innerHTML = `
        <h2 style="font-size: 2.5rem; margin-bottom:5px;">${card.target}</h2>
        <p style="color:#666; font-size:1rem;">${card.native}</p>
        ${card.meta ? `<p class="meta-text">${card.meta}</p>` : ''}
    `;
    
    gameTimer = setTimeout(() => {
        gameIndex++;
        playNextWatchCard();
    }, gameSpeed);
}

function startTestPhase() {
    gamePhase = 'TEST';
    gameIndex = 0;
    gameScore = 0;
    document.getElementById('game-status').textContent = `Round ${gameRound}: Test!`;
    document.getElementById('game-input-area').classList.remove('hidden');
    nextTestCard();
}

function nextTestCard() {
    if (gameIndex >= gameQueue.length) {
        endRound();
        return;
    }
    const card = gameQueue[gameIndex];
    
    // Tag Badge
    const badge = document.getElementById('game-tag-badge');
    if (card.tag) {
        badge.textContent = card.tag;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }

    document.getElementById('game-card-content').innerHTML = `
        <h2 style="font-size: 2.5rem;">${card.target}</h2>
    `;
    const input = document.getElementById('game-input');
    input.value = '';
    input.className = ''; 
    input.focus();
    document.getElementById('btn-game-override').classList.add('hidden');
}

function checkGameAnswer(override = false) {
    const input = document.getElementById('game-input');
    const userVal = input.value;
    const card = gameQueue[gameIndex];
    
    if (override) {
        gameScore++;
        finishCardLogic(true);
        return;
    }

    if (isCloseEnough(userVal, card.native)) {
        gameScore++;
        finishCardLogic(true);
    } else {
        input.classList.add('input-wrong');
        document.getElementById('game-card-content').innerHTML += `
            <p style="color:#1dd1a1; font-weight:bold; margin-top:10px;">${card.native}</p>
        `;
        document.getElementById('btn-game-override').classList.remove('hidden');
        
        if(input.classList.contains('input-wrong_confirmed')) {
             finishCardLogic(false);
        } else {
             input.classList.add('input-wrong_confirmed'); 
        }
    }
}

function finishCardLogic(won) {
    const content = document.getElementById('game-card-content');
    content.style.borderColor = won ? '#1dd1a1' : '#ff6b6b';
    setTimeout(() => {
        content.style.borderColor = '#eee';
        gameIndex++;
        nextTestCard();
    }, won ? 300 : 800);
}

function endRound() {
    if (gameScore === gameQueue.length) {
        const reward = gameRound * 10;
        userCredits += reward;
        saveCredits();
        
        if(confirm(`Round ${gameRound} Cleared! +${reward} ⚡\nReady for faster speed?`)) {
            gameRound++;
            startRound(); 
        } else {
            showView('dashboard');
        }
    } else {
        alert(`Game Over! Score: ${gameScore}/${gameQueue.length}`);
        showView('dashboard');
    }
}

// --- HELPER: LEVENSHTEIN ---
function isCloseEnough(input, target) {
    const s = input.toLowerCase().trim();
    const t = target.toLowerCase().trim();
    if (s === t) return true;
    if (isCJK(t)) return false; 
    if (s.length < 3 || t.length < 3) return s === t;
    
    const track = Array(t.length + 1).fill(null).map(() => Array(s.length + 1).fill(null));
    for (let i = 0; i <= s.length; i++) track[0][i] = i;
    for (let j = 0; j <= t.length; j++) track[j][0] = j;
    for (let j = 1; j <= t.length; j++) {
        for (let i = 1; i <= s.length; i++) {
            const indicator = (s[i - 1] === t[j - 1]) ? 0 : 1;
            track[j][i] = Math.min(track[j][i - 1] + 1, track[j - 1][i] + 1, track[j - 1][i - 1] + indicator);
        }
    }
    return track[t.length][s.length] <= (Math.floor(t.length / 4) + 1);
}

// --- EVENT LISTENERS ---
function setupEventListeners() {
    // Nav
    document.getElementById('btn-add-view').onclick = () => showView('add');
    document.querySelectorAll('.back-btn').forEach(b => b.onclick = () => showView('dashboard'));
    document.getElementById('btn-settings').onclick = () => showView('settings');
    document.getElementById('btn-quit-review').onclick = () => showView('dashboard');
    document.getElementById('btn-quit-game').onclick = () => { clearTimeout(gameTimer); showView('dashboard'); };
    
    // Actions
    document.getElementById('btn-game').onclick = startGame;
    document.getElementById('add-form').onsubmit = saveCard;
    document.getElementById('input-target').addEventListener('input', updateInputLabels);

    // Import
    document.getElementById('btn-open-import').onclick = () => document.getElementById('modal-import').classList.remove('hidden');
    document.getElementById('btn-cancel-import').onclick = () => document.getElementById('modal-import').classList.add('hidden');
    document.getElementById('btn-run-import').onclick = runBulkImport;

    // Cram Config
    document.getElementById('btn-cancel-cram').onclick = () => document.getElementById('modal-cram-settings').classList.add('hidden');
    document.getElementById('btn-start-cram').onclick = runCramSession;
    
    // Cram Toggles
    const cramToggles = document.querySelectorAll('#modal-cram-settings .toggle-btn');
    cramToggles.forEach(t => t.onclick = (e) => {
        cramToggles.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
    });

    // Toggles (Add Form)
    document.getElementById('type-vocab').onclick = (e) => {
        addType = 'VOCAB';
        e.target.classList.add('active');
        document.getElementById('type-sentence').classList.remove('active');
    };
    document.getElementById('type-sentence').onclick = (e) => {
        addType = 'SENTENCE';
        e.target.classList.add('active');
        document.getElementById('type-vocab').classList.remove('active');
    };

    // Review Inputs
    document.getElementById('btn-check-cloze').onclick = checkCloze;
    document.getElementById('cloze-answer').addEventListener('keypress', (e) => { if(e.key === 'Enter') checkCloze(); });
    document.querySelectorAll('.rate-btn').forEach(btn => {
        btn.onclick = () => handleRating(parseInt(btn.dataset.rating));
    });

    // Game Inputs
    document.getElementById('btn-game-submit').onclick = () => checkGameAnswer(false);
    document.getElementById('btn-game-override').onclick = () => checkGameAnswer(true);
    document.getElementById('game-input').addEventListener('keypress', (e) => { 
        if(e.key === 'Enter') checkGameAnswer(false); 
    });

    // Settings
    document.getElementById('btn-clear').onclick = () => {
        if(confirm("Delete all data?")) { cards = []; saveData(); }
    };
    document.getElementById('btn-download').onclick = () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(cards));
        const anchor = document.createElement('a');
        anchor.href = dataStr;
        anchor.download = "flashdeck_v3_backup.json";
        anchor.click();
    };
    document.getElementById('file-upload').onchange = (e) => {
        const reader = new FileReader();
        reader.onload = (ev) => { cards = JSON.parse(ev.target.result); saveData(); alert("Restored!"); };
        reader.readAsText(e.target.files[0]);
    };

    window.editCard = editCard;
    window.deleteCard = deleteCard;
}

init();
