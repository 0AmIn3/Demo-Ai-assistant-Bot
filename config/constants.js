// const OWNER_USERNAME = 'SBatirov';
// const OWNER_USERNAME = 'sard0rs'; // Альтернативный владелец
const { loadDB } = require('../database/db');

const OWNER_USERNAME = '';

/** Возвращает username первого владельца или null, если в БД ещё пусто */
function getOwnerUsername(chatId) {
  const db = loadDB();
  if (chatId !== null) {
    for (let user of db.users) {
      if (user.chatId === chatId && user.isOwner) {
        return user.chatId
      }
    }
  }
  return null
}

/** chat_id владельца (нужен для личных рассылок) */
function getOwnerChatId() {
  const db = loadDB();
  return db.owners?.[0]?.chatId || null;
}
module.exports = {
  OWNER_USERNAME, getOwnerUsername, getOwnerChatId
};
