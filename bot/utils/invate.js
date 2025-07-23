async function getChatInviteLink(bot, chatId, tgOpts = {}) {
    // дефолт: одноразовая ссылка на 24 ч
    const defaults = {
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + 24 * 3600,
        name: `Invite ${Date.now()}`
    };

    try {
        const linkObj = await bot.createChatInviteLink(chatId, {
            ...defaults,
            ...tgOpts
        });
        console.log(linkObj.invite_link);

        return linkObj.invite_link;               // ← success

    } catch (err) {
        // fallback для старого Bot API или недостаточных прав
        if (err.response?.statusCode === 400) {
            return await bot.exportChatInviteLink(chatId);
        }
        throw err;                                // пробрасываем дальше
    }
}
async function fetchMainInviteLink(bot, chatId) {
    const chat = await bot.getChat(chatId);      // Chat объект
    if (chat.invite_link) {
        console.log("Invite link already exists:", chat.invite_link);

        return chat.invite_link;                   // ничего не сломали
    }
    // ссылки нет – создадим её
    return await bot.exportChatInviteLink(chatId);
}
module.exports = { getChatInviteLink, fetchMainInviteLink };