const { loadDB, saveDB } = require('../../database/db');
const { getOwnerUsername, OWNER_USERNAME } = require('../../config/constants');
const { hasActiveCreationSession } = require('../utils/helpers');
const taskService = require('../services/taskService');
const plankaService = require('../services/plankaService');

// Временное хранение данных регистрации сотрудников
const employeeData = {};

// Обработчик команды /start с параметром
function handleStartWithParam(bot, userStates) {
  bot.onText(/\/start (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const ownerId = match[1];

    if (!ownerId) {
      bot.sendMessage(chatId, 'Пожалуйста, используйте ссылку от владельца.');
      return;
    }

    const db = loadDB();
    const owner = db.owners.find((o) => o.id === ownerId);
    if (!owner) {
      bot.sendMessage(chatId, 'Неверная ссылка. Обратитесь к владельцу за новой ссылкой.');
      return;
    }

    employeeData[chatId] = {
      ownerId,
      step: 'email', // Начинаем с запроса email
      userId: msg.from.id,
      username: msg.from.username,
      firstName: msg.from.first_name,
      lastName: msg.from.last_name
    };

    bot.sendMessage(chatId,
      `Добро пожаловать в систему регистрации!\n\n` +
      `Группа: ${owner.groupTitle}\n\n` +
      `Введите ваш email адрес:`
    );
  });
}

// Обработчик команды /start без параметра
function handleStart(bot) {
  bot.onText(/\/start$/, async (msg) => {
    const chatId = msg.chat.id;
    const isOwner = chatId === (getOwnerUsername(chatId) || OWNER_USERNAME);

    const keyboard = {
      inline_keyboard: [
        [{ text: '🤖 Помощь', callback_data: 'show_help' }],
        [{ text: '📋 Мои задачи', callback_data: 'show_my_tasks' }],
        ...(isOwner ? [[{ text: '🔧 Панель владельца', callback_data: 'owner_panel' }]] : [])
      ]
    };

    await bot.sendMessage(
      chatId,
      `Добро пожаловать! Выберите действие:`,
      { reply_markup: keyboard }
    );
  });
}

// Обработчик команды /create_task
function handleCreateTask(bot, userStates, taskCreationSessions) {
  bot.onText(/\/create_task/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    const userId = msg.from.id;

    // Проверяем, что команда только в личном чате
    if (msg.chat.type !== 'private') {
      await bot.sendMessage(chatId, '❌ Создание задач доступно только в личных сообщениях с ботом');
      return;
    }

    // Проверяем, что команда от владельца
    if (chatId !== (getOwnerUsername(chatId) || OWNER_USERNAME)) {
      await bot.sendMessage(chatId, '❌ Эта команда доступна только владельцу');
      return;
    }

    if (hasActiveCreationSession(chatId, userId, userStates, taskCreationSessions)) {
      await bot.sendMessage(
        chatId,
        '⚠️ У вас уже есть незавершённое создание задачи. ' +
        'Завершите его или нажмите «Отмена», прежде чем начинать новую.'
      );
      return;
    }

    userStates[userId] = {
      state: 'creating_task',
      step: 'waiting_message',
      commandMessageId: msg.message_id,
    };

    await bot.sendMessage(chatId,
      '📝 Напишите описание задачи, которую хотите создать.\n' +
      'Я проанализирую ваше сообщение и предложу создать задачу.'
    );
  });
}

// Обработчик команды /my_tasks
function handleMyTasks(bot) {
  bot.onText(/\/my_tasks/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (msg.chat.type !== 'private') {
      return;
    }

    await taskService.showUserTasks(userId, chatId, bot);
  });
}

// Обработчик команды /search (исправлен)
function handleSearch(bot, userStates) {
  bot.onText(/\/search (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;
    const searchQuery = match[1];

    // Поиск доступен всем в личных сообщениях, но с разными правами
    if (msg.chat.type !== 'private') {
      return;
    }

    try {
      // Передаем username для определения типа кнопок (view/edit)
      await taskService.searchTasks(searchQuery, chatId, bot, username);
    } catch (error) {
      console.error('Ошибка поиска:', error);
      await bot.sendMessage(chatId, '❌ Ошибка при поиске задач');
    }
  });
}

// Обработчик команды /search_tasks
function handleSearchTasks(bot, userStates) {
  bot.onText(/\/search_tasks/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;

    if (msg.chat.type !== 'private') {
      return;
    }

    userStates[msg.from.id] = {
      state: 'searching_tasks',
      step: 'waiting_query'
    };

    await bot.sendMessage(chatId,
      '🔍 Введите поисковый запрос для поиска задач (название, описание или ID):\n\n' +
      'Или используйте команду: `/search ваш запрос`',
      { parse_mode: 'Markdown' }
    );
  });
}

// Обработчик команды /done
function handleDone(bot, userStates) {
  bot.onText(/\/done/, async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    await taskService.handleFilesCompletion(userId, chatId, userStates, bot);
  });
}

// Обработчик команды /help
function handleHelp(bot) {
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username;

    let helpMessage = '';

    if (msg.chat.type === 'private') {
      helpMessage =
        '🤖 *Доступные команды:*\n\n' +
        '📋 /my\\_tasks - просмотр ваших задач\n' +
        '❓ /help - эта справка\n\n';

      if (chatId === (getOwnerUsername(chatId) || OWNER_USERNAME)) {
        helpMessage +=
          '🔧 *Команды владельца:*\n\n' +
          '📝 /create\\_task - создать задачу\n' +
          '📊 /stats - показать статистику по задачам\n' +
          '📅 /deadlines - обзор дедлайнов\n' +
          '🔍 /search\\_tasks - поиск и редактирование задач\n\n' +
          '*Создание задач:*\n' +
          '• Используйте команду /create\\_task\n' +
          '• Опишите задачу в следующем сообщении\n' +
          '• Выберите группу (если их несколько)\n' +
          '• Выберите статус и исполнителя\n' +
          '• При необходимости прикрепите файлы\n\n';
      }

      helpMessage +=
        '*Возможности:*\n' +
        '• Просмотр назначенных вам задач\n' +
        '• Перемещение задач между списками\n' +
        '• Получение уведомлений о новых задачах\n';

    } else {
      helpMessage =
        '🤖 *Команды в группе:*\n\n' +
        '❓ /help - эта справка\n\n';

      if (chatId === (getOwnerUsername(chatId) || OWNER_USERNAME)) {
        helpMessage +=
          '🔧 *Команды владельца:*\n' +
          '📊 /stats - показать статистику по задачам\n' +
          '📅 /deadlines - обзор дедлайнов\n\n' +
          '⚠️ *Важно:* Создание задач доступно только в личных сообщениях с ботом\n' +
          'Напишите боту в личку и используйте /create\\_task\n\n';
      } else {
        helpMessage +=
          'Для работы с задачами напишите боту в личные сообщения.';
      }
    }

    await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
  });
}

module.exports = {
  employeeData,
  handleStartWithParam,
  handleStart,
  handleCreateTask,
  handleMyTasks,
  handleSearchTasks,
  handleDone,
  handleHelp
};