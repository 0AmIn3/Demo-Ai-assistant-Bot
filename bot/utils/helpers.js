const { getOwnerUsername, OWNER_USERNAME } = require('../../config/constants');

/**
 * Генерирует правильную кнопку для просмотра/редактирования задачи
 * @param {string} cardId - ID карточки
 * @param {string} username - Username пользователя
 * @returns {Object} Объект кнопки для inline_keyboard
 */
function createTaskViewButton(cardId, username) {
  const isOwner = cardId === (getOwnerUsername(cardId) || OWNER_USERNAME);

  return {
    text: isOwner ? '✏️ Редактировать задачу' : '👁 Посмотреть задачу',
    callback_data: isOwner ? `edit_task_${cardId}` : `view_task_${cardId}`
  };
}

/**
 * Генерирует кнопку возврата к задаче (только просмотр)
 * @param {string} cardId - ID карточки
 * @returns {Object} Объект кнопки для inline_keyboard
 */
function createTaskReturnButton(cardId) {
  return {
    text: '👁 Посмотреть задачу',
    callback_data: `view_task_${cardId}`
  };
}
// Экранирование Markdown символов

function escapeMarkdown(text) {
  return text.replace(/([*_[\]()#+-.!\\])/g, '\\$1');
}

// Генерация пароля
function generatePassword(length = 12) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';

  // Обеспечиваем наличие как минимум одной буквы, цифры и спецсимвола
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const special = '!@#$%^&*';

  password += letters.charAt(Math.floor(Math.random() * letters.length));
  password += numbers.charAt(Math.floor(Math.random() * numbers.length));
  password += special.charAt(Math.floor(Math.random() * special.length));

  // Заполняем остальные позиции случайными символами
  for (let i = 3; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }

  // Перемешиваем символы в пароле
  return password.split('').sort(() => Math.random() - 0.5).join('');
}

// Проверка активной сессии создания задачи
function hasActiveCreationSession(chatId, userId, userStates, taskCreationSessions) {
  if (userStates[userId]?.state === 'creating_task' &&
    userStates[userId].chatId === chatId) {
    return true;
  }

  return Object.values(taskCreationSessions).some(
    (s) => s.chatId === chatId && s.userId === userId
  );
}

// Очистка старых состояний пользователей
function cleanupUserStates(userStates) {
  const now = new Date();
  const oneHour = 60 * 60 * 1000;

  Object.keys(userStates).forEach(userId => {
    const state = userStates[userId];
    if (state.createdAt && (now - new Date(state.createdAt)) > oneHour) {
      delete userStates[userId];
    }
  });
}

module.exports = {
  escapeMarkdown,
  generatePassword,
  hasActiveCreationSession,
  cleanupUserStates,
  createTaskViewButton,
  createTaskReturnButton
};