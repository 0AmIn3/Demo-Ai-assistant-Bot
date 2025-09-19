// bots/registrationBot.js
const TelegramBot = require('node-telegram-bot-api');
const { loadDB, saveDB } = require('../database/db');
const { fetchMainInviteLink } = require('../bot/utils/invate');

const ADMINS = process.env.ADMINS
    ? process.env.ADMINS.split(',').map(id => id.trim())   // массив строк‑ID
    : [];

// Проверка по chatId
const isAdmin = chatId => ADMINS.includes(String(chatId));
const esc = s => (s || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');

/* helpers ----------------------------------------------------------- */
function buildUsersView() {
    const db = loadDB();
    if (!db.users?.length) return { text: 'В базе пока нет пользователей.', keyboard: { inline_keyboard: [] } };

    const rows = db.users.map(u => [
        { text: `${u.name || '—'} — @${u.username || '—'}`, callback_data: `sel_${u.chatId}` }
    ]);

    return { text: '*👥 Пользователи:*', keyboard: { inline_keyboard: rows } };
}

function buildUserCard(u) {
    const db = loadDB();
    const ownerRec = db.owners.find(i => i.chatId === u.chatId);
    const linkLine = ownerRec
        ? `Ссылка: [${`https://t.me/demo_aiassistant_bot?start=${ownerRec.id}`}](https://t.me/demo_aiassistant_bot?start=${ownerRec.id})`
        : '';

    const txt =
        `*Пользователь*  
Имя:  ${esc(u.name)}  
Username: @${esc(u.username)}  
ID:  \`${u.chatId}\`
${linkLine}`;

    return {
        txt,
        kb: {
            inline_keyboard: [
                [{ text: u.isOwner ? '🟢 Owner' : '⚪️ Owner', callback_data: `own_${u.chatId}` }],
                [{ text: '🗑 Удалить', callback_data: `del_${u.chatId}` }],
                [{ text: '↩️ Назад', callback_data: 'back' }]
            ]
        }
    };
}

/* init -------------------------------------------------------------- */
function initRegistrationBot(workBot, regToken) {
    const bot = new TelegramBot(regToken, { polling: true });

    /* обычный /start */
    bot.onText(/^\/start$/, (m) => {
        const db = loadDB();
        db.users = db.users || [];

        /* Уже зарегистрирован */
        if (db.users.find(u => u.chatId === m.chat.id))
            return bot.sendMessage(m.chat.id, '✅ Вы уже зарегистрированы.');

        /* Новая регистрация */
        db.users.push({
            username: m.from.username ?? null,
            name: m.from.first_name ?? '—',
            chatId: m.chat.id,
            isOwner: false,
            createdAt: new Date().toISOString()
        });
        saveDB(db);

        bot.sendMessage(m.chat.id, '🎉 Регистрация завершена!');

        /* Уведомляем всех админов */
        const note =
            `👤 *Новый пользователь зарегистрировался*
Имя:  ${esc(m.from.first_name)}
Username: @${esc(m.from.username || '—')}
ID:  \`${m.chat.id}\``;
        ADMINS.forEach(id => bot.sendMessage(id, note, { parse_mode: 'MarkdownV2' }));
    });

    /* список пользователей */
    bot.onText(/^\/users$/, (m) => {
        if (!isAdmin(m.chat.id)) return;
        const { text, keyboard } = buildUsersView();
        bot.sendMessage(m.chat.id, text, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
    });

    /* callback queries */
    bot.on('callback_query', async (cb) => {
        if (!isAdmin(cb.message.chat.id)) return bot.answerCallbackQuery(cb.id);

        const chatId = cb.message.chat.id;
        const messageId = cb.message.message_id;
        const db = loadDB();

        /* показать карточку */
        if (cb.data.startsWith('sel_')) {
            const uid = +cb.data.slice(4);
            const u = db.users.find(x => x.chatId === uid);
            if (u) {
                const { txt, kb } = buildUserCard(u);
                await bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: kb });
            }
            return bot.answerCallbackQuery(cb.id);
        }

        /* toggle owner -------------------------------------------------- */
        if (cb.data.startsWith('own_')) {
            const uid = +cb.data.slice(4);
            const user = db.users.find(x => x.chatId === uid);
            if (!user) return;

            user.isOwner = !user.isOwner;                    // переключение
            db.owners = db.owners || [];

            if (user.isOwner) {
                /* добавляем владельца */
                let ownerRec = db.owners.find(o => o.chatId === uid);
                if (!ownerRec) {
                    ownerRec = {
                        id: Date.now().toString(),           // токен‑приглашение
                        telegramGroupId: "-1002765433923",
                        groupTitle: "Demo Assistant Group",
                        username: user.username,
                        chatId: uid,
                        createdAt: new Date().toISOString()
                    };
                    db.owners.push(ownerRec);
                }

                const inviteLink = await fetchMainInviteLink(workBot, "-1002765433923");
                /* уведомление новому владельцу */
                const link = `https://t.me/demo\\_aiassistant\\_bot?start=${ownerRec.id}`;
                bot.sendMessage(uid,
 `🎉 *Вас назначили владельцем!*

Отправьте эту ссылку своим сотрудникам для регистрации:
${link}

❗️Если планируете назначать задачи на себя, тоже перейдите по этой же ссылке и зарегистрируйтесь как сотрудник.

Ссылка на рабочую группу: ${inviteLink}`,
 { parse_mode: 'Markdown' });

            } else {
                /* снимаем владельца */
                db.owners = db.owners.filter(o => o.chatId !== uid);
            }

            saveDB(db);
            await bot.answerCallbackQuery(cb.id, { text: user.isOwner ? 'Назначен владельцем' : 'Снят' });

            const { txt, kb } = buildUserCard(user);
            return bot.editMessageText(txt, {
                chat_id: chatId, message_id: messageId,
                parse_mode: 'Markdown', reply_markup: kb
            });
        }

        /* delete user */
        if (cb.data.startsWith('del_')) {
            const uid = +cb.data.slice(4);
            db.users = db.users.filter(u => u.chatId !== uid);
            db.owners = (db.owners || []).filter(o => o.chatId !== uid);
            saveDB(db);
            await bot.answerCallbackQuery(cb.id, { text: 'Удалён' });

            const { text, keyboard } = buildUsersView();
            return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2', reply_markup: keyboard });
        }

        /* back */
        if (cb.data === 'back') {
            await bot.answerCallbackQuery(cb.id);
            const { text, keyboard } = buildUsersView();
            return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'MarkdownV2', reply_markup: keyboard });
        }
    });

    bot.onText(/^\/admin_help$/, (msg) => {
        if (!isAdmin(msg.chat.id)) return;
        bot.sendMessage(
            msg.chat.id,
            `*Команды админа*

/users — список & управление  
/start — регистрация обычного пользователя`,
            { parse_mode: 'Markdown' }
        );
    });
    return bot;
}

module.exports = { initRegistrationBot };
