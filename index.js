require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');

// Импорты модулей
const { initDB } = require('./database/db');
const { cleanupUserStates } = require('./bot/utils/helpers');
const apiRoutes = require('./api/routes');
const { OWNER_USERNAME } = require('./config/constants');
// Импорты обработчиков бота
const commands = require('./bot/handlers/commands');
const messages = require('./bot/handlers/messages');
const callbacks = require('./bot/handlers/callbacks');
const DeadlineScheduler = require('./bot/services/deadlineScheduler');
const statisticsService = require('./bot/services/statisticsService');
// Инициализация
const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Инициализация базы данных
initDB();

// Состояния пользователей и сессии
const userStates = {}; // Для хранения состояний пользователей
const taskCreationSessions = {}; // Временное хранилище для создания задач

// Middleware
app.use(express.json());

// Делаем bot доступным для API роутов
app.set('telegramBot', bot);


const deadlineScheduler = new DeadlineScheduler(bot);



// API роуты
app.use('/', apiRoutes);
``
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username;

  if (username !== OWNER_USERNAME) {
    await bot.sendMessage(chatId, '❌ Эта команда доступна только владельцу');
    return;
  }
  if (msg.chat.type !== 'private') {
    return;
  }
  await statisticsService.generateStatistics('30d', chatId, bot);
});

// Команда просмотра дедлайнов
bot.onText(/\/deadlines/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username;

  if (username !== OWNER_USERNAME) {
    await bot.sendMessage(chatId, '❌ Эта команда доступна только владельцу');
    return;
  }
  if (msg.chat.type !== 'private') {
    return;
  }
  try {
    const tasks = await getAllTasksWithDeadlines();
    const now = new Date();

    const upcomingTasks = tasks.filter(task => {
      const dueDate = new Date(task.dueDate);
      const timeDiff = dueDate.getTime() - now.getTime();
      const daysDiff = timeDiff / (1000 * 60 * 60 * 24);
      return daysDiff <= 7 && daysDiff > 0;
    });

    const overdueTasks = tasks.filter(task => {
      const dueDate = new Date(task.dueDate);
      return dueDate < now;
    });

    let message = '📅 *Обзор дедлайнов*\n\n';

    if (overdueTasks.length > 0) {
      message += `🚨 *Просроченные задачи (${overdueTasks.length}):*\n`;
      overdueTasks.slice(0, 5).forEach((task, index) => {
        const dueDate = new Date(task.dueDate);
        const overdueDays = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
        message += `${index + 1}. ${task.name} (просрочено на ${overdueDays}д)\n`;
      });
      message += '\n';
    }

    if (upcomingTasks.length > 0) {
      message += `⏰ *Ближайшие дедлайны (${upcomingTasks.length}):*\n`;
      upcomingTasks.slice(0, 5).forEach((task, index) => {
        const dueDate = new Date(task.dueDate);
        const daysDiff = Math.floor((dueDate - now) / (1000 * 60 * 60 * 24));
        message += `${index + 1}. ${task.name} (через ${daysDiff}д)\n`;
      });
    }

    if (overdueTasks.length === 0 && upcomingTasks.length === 0) {
      message += '✅ Нет критичных дедлайнов на ближайшую неделю';
    }

    await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Показать статистику', callback_data: 'show_statistics' }],
          [{ text: '⚠️ Проблемные задачи', callback_data: 'problem_tasks' }]
        ]
      }
    });

  } catch (error) {
    console.error('Ошибка получения дедлайнов:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при получении информации о дедлайнах');
  }
});
bot.onText(/\/link/, (msg) => {
  const chatId = msg.chat.id;
console.log(fetchMainInviteLink(bot, chatId));

  // bot.sendMessage(chatId, `Here's the invite link: ${fetchMainInviteLink(bot, chatId)}`);
  // bot.exportChatInviteLink(chatId)
  //   .then((inviteLink) => {
  //     
  //   })
  //   .catch((error) => {
  //     console.error("Error exporting invite link:", error);
  //     bot.sendMessage(chatId, "Error creating invite link.");
  //   });
});

async function fetchMainInviteLink(bot, chatId) {
  const chat = await bot.getChat(chatId);
  console.log(chat);
       // Chat объект
  if (chat.invite_link) {
    console.log("Invite link already exists:", chat.invite_link);
    
    return chat.invite_link;                   // ничего не сломали
  }
  // ссылки нет – создадим её
  return await bot.exportChatInviteLink(chatId);
}
// Обновленная команда помощи для владельца
bot.onText(/\/owner_help/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username;

  if (username !== OWNER_USERNAME) {
    await bot.sendMessage(chatId, '❌ Эта команда доступна только владельцу');
    return;
  }
  if (msg.chat.type !== 'private') {
    return;
  }
  const helpMessage = `
🔧 *Команды владельца:*

📊 */stats* - Показать статистику по задачам
📅 */deadlines* - Обзор дедлайнов  

📋 *Доступная статистика:*
• Общие показатели выполнения
• Детальная статистика по сотрудникам
• Анализ по приоритетам и статусам
• Статус проблемных задач

🔔 *Система уведомлений:*
• Сотрудники: напоминания за 24ч, 6ч, 2ч до дедлайна
• Владелец: уведомления о просроченных задачах
• Ежедневный дайджест (9:00 по Ташкенту)

⚙️ *Автоматические функции:*
• Проверка дедлайнов каждые 30 минут
• Умное определение приоритетов через лейблы
• Автоназначение исполнителей при создании задач
`;

  await bot.sendMessage(chatId, helpMessage, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📊 Статистика', callback_data: 'show_statistics' },
          { text: '📅 Дедлайны', callback_data: 'show_deadlines' }
        ]
      ]
    }
  });
});

// Вспомогательная функция
async function getAllTasksWithDeadlines() {
  try {
    const plankaService = require('./bot/services/plankaService');
    const accessToken = await plankaService.getPlankaAccessToken();
    const axios = require('axios');

    const response = await axios.get(
      `${process.env.PLANKA_BASE_URL}/boards/${process.env.PLANKA_BOARD_ID}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    const cards = response.data.included.cards || [];
    const cardMemberships = response.data.included.cardMemberships || [];

    return cards
      .filter(card => card.dueDate && !card.isDueDateCompleted)
      .map(card => ({
        ...card,
        assignees: cardMemberships
          .filter(membership => membership.cardId === card.id)
          .map(membership => membership.userId)
      }))
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  } catch (error) {
    console.error('Ошибка получения задач с дедлайнами:', error);
    return [];
  }
}



bot.onText(/\/chatinfo/, (msg) => {
  const chatId = msg.chat.id;

  const chatInfo = `Информация о чате:

**ID чата:** \`${chatId}\`
**Тип чата:** ${msg.chat.type}
**Название:** ${msg.chat.title || msg.chat.first_name || 'Не указано'}
**Username:** @${msg.chat.username || 'Не указан'}

${msg.chat.type === 'group' ? ' Это обычная группа' : ''}
${msg.chat.type === 'supergroup' ? ' Это супергруппа' : ''}
${msg.chat.type === 'private' ? ' Это личный чат' : ''}`;

  bot.sendMessage(chatId, chatInfo, { parse_mode: 'Markdown' });
}); ``
// Настройка обработчиков команд
commands.handleStartWithParam(bot, userStates);
commands.handleStart(bot);
commands.handleCreateTask(bot, userStates, taskCreationSessions);
commands.handleMyTasks(bot);
commands.handleSearchTasks(bot, userStates);
commands.handleDone(bot, userStates);
commands.handleHelp(bot);

// Настройка обработчиков сообщений
messages.handleMessages(bot, userStates, taskCreationSessions, openai);
messages.handleVoiceMessages(bot, userStates, taskCreationSessions, openai);
messages.handleDocuments(bot, userStates, taskCreationSessions);
messages.handlePhotos(bot, userStates, taskCreationSessions);

// Настройка обработчиков callback'ов
callbacks.handleCallbacks(bot, userStates, taskCreationSessions);

// Очистка старых состояний каждый час
setInterval(() => cleanupUserStates(userStates), 60 * 60 * 1000);

// Обработка ошибок бота
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

// Обработка ошибок состояний
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Очищаем состояния при критических ошибках
  Object.keys(userStates).forEach(userId => {
    delete userStates[userId];
  });
});

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('Stopping bot...');
  bot.stopPolling();
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('Stopping bot...');
  bot.stopPolling();
  process.exit(0);
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('Telegram bot is running...');
});