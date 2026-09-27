const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse: parseUrl } = require('url');

const PORT = process.env.PORT || 3000;
const DATA_DIR = '/data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const DM_FILE = path.join(DATA_DIR, 'dm.json');
// Аватар/картинка поста (base64 dataURL) до 10 МБ раздувается примерно в ~1.37 раза в JSON,
// плюс небольшой запас на остальные поля запроса.
const MAX_BODY_SIZE = 14 * 1024 * 1024;
const POST_TEXT_MAX_LEN = 3000;
const POSTS_PER_WALL = 100;
const DM_HISTORY_LIMIT = 300;
const DM_MESSAGE_MAX_LEN = 2000;
const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/;

console.log('Путь к файлу users.json:', USERS_FILE);

/* ---------- Работа с файлом ---------- */

function readUsers() {
    try {
        if (!fs.existsSync(USERS_FILE)) return [];
        const raw = fs.readFileSync(USERS_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (e) {
        console.error('Ошибка чтения:', e);
        return [];
    }
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    console.log('💾 Файл users.json сохранён');
}

function readPosts() {
    try {
        if (!fs.existsSync(POSTS_FILE)) return [];
        const raw = fs.readFileSync(POSTS_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (e) {
        console.error('Ошибка чтения постов:', e);
        return [];
    }
}

function savePosts(posts) {
    fs.writeFileSync(POSTS_FILE, JSON.stringify(posts, null, 2), 'utf8');
}

function readDms() {
    try {
        if (!fs.existsSync(DM_FILE)) return [];
        const raw = fs.readFileSync(DM_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (e) {
        console.error('Ошибка чтения личных сообщений:', e);
        return [];
    }
}

function saveDms(dms) {
    fs.writeFileSync(DM_FILE, JSON.stringify(dms, null, 2), 'utf8');
}

function normalizeHandle(raw) {
    return (raw || '').trim().replace(/^@+/, '');
}

function dmKey(a, b) {
    return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('::');
}

function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- Хеширование ---------- */

function hashPassword(password, salt) {
    return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

function generateSalt() {
    return crypto.randomBytes(16).toString('hex');
}

/* ---------- Ответы ---------- */

function sendJSON(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
    });
    res.end(JSON.stringify(data));
}

function sendFile(res, filePath, contentType) {
    fs.readFile(filePath, function (err, data) {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Файл не найден');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

function readBody(req) {
    return new Promise(function (resolve, reject) {
        let body = '';
        req.on('data', function (chunk) {
            body += chunk;
            if (body.length > MAX_BODY_SIZE) {
                reject(new Error('Слишком большой запрос'));
                req.destroy();
            }
        });
        req.on('end', function () {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Некорректный JSON'));
            }
        });
        req.on('error', reject);
    });
}

/* ---------- API ---------- */

async function handleRegister(req, res) {
    try {
        const data = await readBody(req);
        const username = (data.username || '').trim();
        const email = (data.email || '').trim();
        const password = data.password || '';

        console.log('📥 Регистрация:', username, email);

        if (username.length < 3) {
            return sendJSON(res, 400, { error: 'Имя — минимум 3 символа' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return sendJSON(res, 400, { error: 'Некорректный email' });
        }
        if (password.length < 6) {
            return sendJSON(res, 400, { error: 'Пароль — минимум 6 символов' });
        }

        const users = readUsers();
        const lowerName = username.toLowerCase();
        const lowerEmail = email.toLowerCase();

        for (let i = 0; i < users.length; i++) {
            if (users[i].username.toLowerCase() === lowerName) {
                return sendJSON(res, 409, { error: 'Такое имя уже занято' });
            }
            if (users[i].email.toLowerCase() === lowerEmail) {
                return sendJSON(res, 409, { error: 'Эта почта уже зарегистрирована' });
            }
        }

        const salt = generateSalt();
        const passwordHash = hashPassword(password, salt);

        const newUser = {
            username: username,
            email: email,
            salt: salt,
            passwordHash: passwordHash,
            avatar: '',
            handle: '',
            createdAt: new Date().toISOString()
        };

        users.push(newUser);
        saveUsers(users);

        console.log('✅ Зарегистрирован:', username);
        sendJSON(res, 201, {
            username: newUser.username,
            email: newUser.email,
            avatar: newUser.avatar,
            handle: newUser.handle
        });
    } catch (e) {
        console.error('❌ Ошибка регистрации:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

async function handleLogin(req, res) {
    try {
        const data = await readBody(req);
        const login = (data.login || '').trim().toLowerCase();
        const password = data.password || '';

        console.log('📥 Вход:', login);

        if (!login || !password) {
            return sendJSON(res, 400, { error: 'Введите логин и пароль' });
        }

        const users = readUsers();
        let user = null;

        for (let i = 0; i < users.length; i++) {
            if (users[i].username.toLowerCase() === login ||
                users[i].email.toLowerCase() === login) {
                user = users[i];
                break;
            }
        }

        if (!user) {
            return sendJSON(res, 404, { error: 'Пользователь не найден' });
        }

        const hash = hashPassword(password, user.salt);
        if (hash !== user.passwordHash) {
            return sendJSON(res, 401, { error: 'Неверный пароль' });
        }

        console.log('✅ Вошёл:', user.username);
        sendJSON(res, 200, {
            username: user.username,
            email: user.email,
            avatar: user.avatar || '',
            handle: user.handle || ''
        });
    } catch (e) {
        console.error('❌ Ошибка входа:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

function handleUsersList(req, res) {
    const users = readUsers();
    const safe = users.map(function (u) {
        return { username: u.username, email: u.email, avatar: u.avatar || '', handle: u.handle || '', createdAt: u.createdAt };
    });
    sendJSON(res, 200, { users: safe });
}

function handleUserSearch(req, res, query) {
    const q = normalizeHandle(query.q || '').toLowerCase();
    const users = readUsers();
    let results = users;
    if (q) {
        results = users.filter(function (u) {
            const handle = (u.handle || '').toLowerCase();
            const uname = u.username.toLowerCase();
            return handle.indexOf(q) !== -1 || uname.indexOf(q) !== -1;
        });
    }
    const safe = results.slice(0, 20).map(function (u) {
        return { username: u.username, avatar: u.avatar || '', handle: u.handle || '' };
    });
    sendJSON(res, 200, { users: safe });
}

async function handleUpdateProfile(req, res) {
    try {
        const data = await readBody(req);
        const currentUsername = (data.currentUsername || '').trim();
        const newUsername = (data.newUsername || '').trim();
        const hasAvatar = Object.prototype.hasOwnProperty.call(data, 'avatar');
        const avatar = data.avatar;
        const hasHandle = Object.prototype.hasOwnProperty.call(data, 'handle');
        const handle = hasHandle ? normalizeHandle(typeof data.handle === 'string' ? data.handle : '') : null;

        console.log('📥 Обновление профиля:', currentUsername, '→', newUsername);

        if (!currentUsername) {
            return sendJSON(res, 400, { error: 'Не указан текущий пользователь' });
        }
        if (newUsername.length < 3 || newUsername.length > 20) {
            return sendJSON(res, 400, { error: 'Ник — от 3 до 20 символов' });
        }
        if (hasAvatar && typeof avatar === 'string' && avatar.length > MAX_BODY_SIZE) {
            return sendJSON(res, 400, { error: 'Аватар слишком большой' });
        }
        if (hasHandle && handle && !HANDLE_RE.test(handle)) {
            return sendJSON(res, 400, { error: 'Юзернейм: 3-20 символов, латиница, цифры и _' });
        }

        const users = readUsers();
        let user = null;
        for (let i = 0; i < users.length; i++) {
            if (users[i].username.toLowerCase() === currentUsername.toLowerCase()) {
                user = users[i];
                break;
            }
        }
        if (!user) {
            return sendJSON(res, 404, { error: 'Пользователь не найден' });
        }

        const lowerNewName = newUsername.toLowerCase();
        if (lowerNewName !== user.username.toLowerCase()) {
            for (let i = 0; i < users.length; i++) {
                if (users[i] !== user && users[i].username.toLowerCase() === lowerNewName) {
                    return sendJSON(res, 409, { error: 'Такое имя уже занято' });
                }
            }
        }
        if (hasHandle && handle) {
            const lowerHandle = handle.toLowerCase();
            for (let i = 0; i < users.length; i++) {
                if (users[i] !== user && (users[i].handle || '').toLowerCase() === lowerHandle) {
                    return sendJSON(res, 409, { error: 'Такой юзернейм уже занят' });
                }
            }
        }

        user.username = newUsername;
        if (hasAvatar) {
            user.avatar = typeof avatar === 'string' ? avatar : '';
        }
        if (hasHandle) {
            user.handle = handle;
        }

        saveUsers(users);

        console.log('✅ Профиль обновлён:', user.username);
        sendJSON(res, 200, {
            username: user.username,
            email: user.email,
            avatar: user.avatar || '',
            handle: user.handle || ''
        });
    } catch (e) {
        console.error('❌ Ошибка обновления профиля:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

/* ---------- Страница (посты) ---------- */

function handlePostsGet(req, res, query) {
    const username = (query.username || '').trim();
    if (!username) {
        return sendJSON(res, 400, { error: 'Не указан пользователь' });
    }
    const posts = readPosts();
    const filtered = posts.filter(function (p) {
        return p.username.toLowerCase() === username.toLowerCase();
    });
    filtered.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    sendJSON(res, 200, { posts: filtered.slice(0, POSTS_PER_WALL) });
}

async function handlePostsCreate(req, res) {
    try {
        const data = await readBody(req);
        const username = (data.username || '').trim();
        const text = (data.text || '').trim();
        const image = typeof data.image === 'string' ? data.image : '';

        if (!username) {
            return sendJSON(res, 400, { error: 'Не указан автор' });
        }
        if (!text && !image) {
            return sendJSON(res, 400, { error: 'Пустой пост — добавь текст или картинку' });
        }
        if (text.length > POST_TEXT_MAX_LEN) {
            return sendJSON(res, 400, { error: 'Текст слишком длинный' });
        }
        if (image && image.length > MAX_BODY_SIZE) {
            return sendJSON(res, 400, { error: 'Картинка слишком большая' });
        }

        const users = readUsers();
        let author = null;
        for (let i = 0; i < users.length; i++) {
            if (users[i].username.toLowerCase() === username.toLowerCase()) {
                author = users[i];
                break;
            }
        }
        if (!author) {
            return sendJSON(res, 404, { error: 'Пользователь не найден' });
        }

        const post = {
            id: makeId(),
            username: author.username,
            avatar: author.avatar || '',
            text: text,
            image: image,
            createdAt: new Date().toISOString()
        };

        const posts = readPosts();
        posts.push(post);
        // Храним не больше последних 2000 постов суммарно по всем пользователям.
        const trimmed = posts.length > 2000 ? posts.slice(-2000) : posts;
        savePosts(trimmed);

        console.log('📝 Новый пост:', author.username);
        sendJSON(res, 201, { post: post });
    } catch (e) {
        console.error('❌ Ошибка публикации поста:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

async function handlePostDelete(req, res, query) {
    try {
        const id = (query.id || '').trim();
        const username = (query.username || '').trim();
        if (!id || !username) {
            return sendJSON(res, 400, { error: 'Не хватает параметров' });
        }
        const posts = readPosts();
        const idx = posts.findIndex(function (p) { return p.id === id; });
        if (idx === -1) {
            return sendJSON(res, 404, { error: 'Пост не найден' });
        }
        if (posts[idx].username.toLowerCase() !== username.toLowerCase()) {
            return sendJSON(res, 403, { error: 'Нельзя удалить чужой пост' });
        }
        posts.splice(idx, 1);
        savePosts(posts);
        sendJSON(res, 200, { ok: true });
    } catch (e) {
        console.error('❌ Ошибка удаления поста:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

/* ---------- Личные сообщения ---------- */

function handleDmGet(req, res, query) {
    const user = (query.user || '').trim();
    const withUser = (query.with || '').trim();
    if (!user || !withUser) {
        return sendJSON(res, 400, { error: 'Не указаны участники диалога' });
    }
    const key = dmKey(user, withUser);
    const dms = readDms();
    let changed = false;
    for (let i = 0; i < dms.length; i++) {
        const m = dms[i];
        if (dmKey(m.from, m.to) === key && m.to.toLowerCase() === user.toLowerCase() && !m.read) {
            m.read = true;
            changed = true;
        }
    }
    if (changed) {
        saveDms(dms);
    }
    const conv = dms.filter(function (m) { return dmKey(m.from, m.to) === key; });
    sendJSON(res, 200, { messages: conv.slice(-DM_HISTORY_LIMIT) });
}

async function handleDmCreate(req, res) {
    try {
        const data = await readBody(req);
        const from = (data.from || '').trim();
        const to = (data.to || '').trim();
        const text = (data.text || '').trim();

        if (!from || !to) {
            return sendJSON(res, 400, { error: 'Не указаны участники' });
        }
        if (from.toLowerCase() === to.toLowerCase()) {
            return sendJSON(res, 400, { error: 'Нельзя написать самому себе' });
        }
        if (!text) {
            return sendJSON(res, 400, { error: 'Сообщение пустое' });
        }
        if (text.length > DM_MESSAGE_MAX_LEN) {
            return sendJSON(res, 400, { error: 'Сообщение слишком длинное' });
        }

        const users = readUsers();
        const fromExists = users.some(function (u) { return u.username.toLowerCase() === from.toLowerCase(); });
        const toUser = users.find(function (u) { return u.username.toLowerCase() === to.toLowerCase(); });
        if (!fromExists) {
            return sendJSON(res, 404, { error: 'Отправитель не найден' });
        }
        if (!toUser) {
            return sendJSON(res, 404, { error: 'Получатель не найден' });
        }

        const message = {
            id: makeId(),
            from: from,
            to: toUser.username,
            text: text,
            read: false,
            createdAt: new Date().toISOString()
        };

        const dms = readDms();
        dms.push(message);
        // Храним не больше последних 5000 личных сообщений суммарно.
        const trimmed = dms.length > 5000 ? dms.slice(-5000) : dms;
        saveDms(trimmed);

        console.log('✉️', from, '→', toUser.username);
        sendJSON(res, 201, { message: message });
    } catch (e) {
        console.error('❌ Ошибка отправки личного сообщения:', e);
        sendJSON(res, 500, { error: 'Ошибка сервера' });
    }
}

function handleDmConversations(req, res, query) {
    const user = (query.user || '').trim();
    if (!user) {
        return sendJSON(res, 400, { error: 'Не указан пользователь' });
    }
    const lowerUser = user.toLowerCase();
    const dms = readDms();
    const users = readUsers();
    const map = {};

    for (let i = 0; i < dms.length; i++) {
        const m = dms[i];
        const fromLower = m.from.toLowerCase();
        const toLower = m.to.toLowerCase();
        if (fromLower !== lowerUser && toLower !== lowerUser) continue;

        const partnerName = fromLower === lowerUser ? m.to : m.from;
        const partnerLower = partnerName.toLowerCase();

        if (!map[partnerLower]) {
            map[partnerLower] = { partnerUsername: partnerName, lastMessage: m, unread: 0 };
        }
        if (new Date(m.createdAt) > new Date(map[partnerLower].lastMessage.createdAt)) {
            map[partnerLower].lastMessage = m;
        }
        if (toLower === lowerUser && !m.read) {
            map[partnerLower].unread++;
        }
    }

    const list = Object.keys(map).map(function (k) {
        const entry = map[k];
        const partnerUser = users.find(function (u) { return u.username.toLowerCase() === k; });
        return {
            username: partnerUser ? partnerUser.username : entry.partnerUsername,
            avatar: partnerUser ? (partnerUser.avatar || '') : '',
            handle: partnerUser ? (partnerUser.handle || '') : '',
            lastText: entry.lastMessage.text,
            lastFrom: entry.lastMessage.from,
            lastAt: entry.lastMessage.createdAt,
            unread: entry.unread
        };
    });
    list.sort(function (a, b) { return new Date(b.lastAt) - new Date(a.lastAt); });

    sendJSON(res, 200, { conversations: list });
}

function handleDmUnreadCount(req, res, query) {
    const user = (query.user || '').trim();
    if (!user) {
        return sendJSON(res, 400, { error: 'Не указан пользователь' });
    }
    const lowerUser = user.toLowerCase();
    const dms = readDms();
    let count = 0;
    for (let i = 0; i < dms.length; i++) {
        if (dms[i].to.toLowerCase() === lowerUser && !dms[i].read) count++;
    }
    sendJSON(res, 200, { count: count });
}

/* ---------- Сервер ---------- */

const server = http.createServer(function (req, res) {
    const parsedUrl = parseUrl(req.url, true);
    const url = parsedUrl.pathname;
    const query = parsedUrl.query;

    console.log('→', req.method, url);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
        });
        res.end();
        return;
    }

    if (url === '/api/register' && req.method === 'POST') {
        return handleRegister(req, res);
    }
    if (url === '/api/login' && req.method === 'POST') {
        return handleLogin(req, res);
    }
    if (url === '/api/users' && req.method === 'GET') {
        return handleUsersList(req, res);
    }
    if (url === '/api/update-profile' && req.method === 'POST') {
        return handleUpdateProfile(req, res);
    }
    if (url === '/api/users/search' && req.method === 'GET') {
        return handleUserSearch(req, res, query);
    }
    if (url === '/api/posts' && req.method === 'GET') {
        return handlePostsGet(req, res, query);
    }
    if (url === '/api/posts' && req.method === 'POST') {
        return handlePostsCreate(req, res);
    }
    if (url === '/api/posts' && req.method === 'DELETE') {
        return handlePostDelete(req, res, query);
    }
    if (url === '/api/dm' && req.method === 'GET') {
        return handleDmGet(req, res, query);
    }
    if (url === '/api/dm' && req.method === 'POST') {
        return handleDmCreate(req, res);
    }
    if (url === '/api/dm/conversations' && req.method === 'GET') {
        return handleDmConversations(req, res, query);
    }
    if (url === '/api/dm/unread-count' && req.method === 'GET') {
        return handleDmUnreadCount(req, res, query);
    }

    if (url === '/' || url === '/index.html') {
        return sendFile(res, path.join(__dirname, 'index.html'), 'text/html; charset=utf-8');
    }

    // Отдаём 404 тоже в JSON, чтобы fetch(...).then(res => res.json())
    // на фронте никогда не падал с "Unexpected token" на текстовом ответе.
    sendJSON(res, 404, { error: 'Не найдено' });
});

server.listen(PORT, '0.0.0.0', function () {
    console.log('');
    console.log('🔥 Сервер Hot запущен!');
    console.log('👉 Открой: http://localhost:' + PORT);
    console.log('📁 Файл users.json будет тут:', USERS_FILE);
    console.log('');
});
