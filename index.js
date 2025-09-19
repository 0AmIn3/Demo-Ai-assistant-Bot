// ───────────────────────────────────────────────────────────────────────────────
// server.js
// ───────────────────────────────────────────────────────────────────────────────
require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require('openai');                // v4 SDK

// ─── внутренние модули ────────────────────────────────────────────────────────
const { initDB } = require('./database/db');
const { cleanupUserStates } = require('./bot/utils/helpers');
const apiRoutes = require('./api/routes');
const { getOwnerUsername } = require('./config/constants');

const commands = require('./bot/handlers/commands');
const messages = require('./bot/handlers/messages');
const callbacks = require('./bot/handlers/callbacks');
const DeadlineScheduler = require('./bot/services/deadlineScheduler');
const statisticsService = require('./bot/services/statisticsService');
const plankaService = require('./bot/services/plankaService');

// ─── глобальные хранилища ─────────────────────────────────────────────────────
const userStates = {};           // состояния диалогов
const taskCreationSessions = {};           // temp-данные при создании задач

// ─── инициализация ────────────────────────────────────────────────────────────
initDB();
const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── рабочий бот ──────────────────────────────────────────────────────────────
const workBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
app.set('telegramBot', workBot);
module.exports.workBot = workBot;

// ─── регистрационный бот ──────────────────────────────────────────────────────
const { initRegistrationBot } = require('./bots/registrationBot');
const regBot = initRegistrationBot(workBot, process.env.REGISTRATION_BOT_TOKEN);
app.set('registrationBot', regBot);

// ─── планировщик дедлайнов ────────────────────────────────────────────────────
new DeadlineScheduler(workBot);

// ─── REST API ─────────────────────────────────────────────────────────────────
app.use('/', apiRoutes);

// ─── утилиты ──────────────────────────────────────────────────────────────────
async function getAllTasksWithDeadlines() {
  try {
    const accessToken = await plankaService.getPlankaAccessToken();
    const axios = require('axios');

    const { data } = await axios.get(
      `${process.env.PLANKA_BASE_URL}/boards/${process.env.PLANKA_BOARD_ID}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const cards = data.included.cards || [];
    const memberships = data.included.cardMemberships || [];

    return cards
      .filter(c => c.dueDate && !c.isDueDateCompleted)
      .map(c => ({
        ...c,
        assignees: memberships
          .filter(m => m.cardId === c.id)
          .map(m => m.userId)
      }))
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  } catch (e) {
    console.error('Planka error:', e);
    return [];
  }
}

async function fetchMainInviteLink(bot, chatId) {
  const chat = await bot.getChat(chatId);
  return chat.invite_link || bot.exportChatInviteLink(chatId);
}

// ─── команды, доступные только владельцу ─────────────────────────────────────
workBot.onText(/\/stats/, async (msg) => {
  const { id: chatId, type, messageId } = msg.chat;
  if (chatId !== getOwnerUsername(chatId) || type !== 'private') return;
  await statisticsService.generateStatistics('30d', chatId, messageId, workBot);
});

workBot.onText(/\/deadlines/, async (msg) => {
  const { id: chatId, type } = msg.chat;
  if (chatId !== getOwnerUsername(chatId) || type !== 'private') return;

  try {
    const tasks = await getAllTasksWithDeadlines();
    const now = new Date();

    const upcoming = tasks.filter(t => {
      const d = new Date(t.dueDate);
      const diffDays = (d - now) / 86_400_000;
      return diffDays > 0 && diffDays <= 7;
    });
    const overdue = tasks.filter(t => new Date(t.dueDate) < now);

    let out = '📅 *Обзор дедлайнов*\n\n';
    if (overdue.length) {
      out += `🚨 *Просроченные (${overdue.length}):*\n`;
      overdue.slice(0, 5).forEach((t, i) => {
        const days = Math.floor((now - new Date(t.dueDate)) / 86_400_000);
        out += `${i + 1}. ${t.name} (на ${days}д просрочено)\n`;
      });
      out += '\n';
    }
    if (upcoming.length) {
      out += `⏰ *Ближайшие (${upcoming.length}):*\n`;
      upcoming.slice(0, 5).forEach((t, i) => {
        const days = Math.floor((new Date(t.dueDate) - now) / 86_400_000);
        out += `${i + 1}. ${t.name} (через ${days}д)\n`;
      });
    }
    if (!overdue.length && !upcoming.length)
      out += '✅ Нет критичных дедлайнов на ближайшую неделю';

    await workBot.sendMessage(chatId, out, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Показать статистику', callback_data: 'show_statistics' }],
          [{ text: '⚠️ Проблемные задачи', callback_data: 'problem_tasks' }]
        ]
      }
    });
  } catch (e) {
    console.error(e);
    workBot.sendMessage(chatId, '❌ Ошибка при получении дедлайнов');
  }
});

workBot.onText(/\/owner_help/, async (msg) => {
  const { id: chatId, type } = msg.chat;
  if (chatId !== getOwnerUsername(chatId) || type !== 'private') return;

  await workBot.sendMessage(chatId,
    `🔧 *Команды владельца*  

• /stats – статистика  
• /deadlines – обзор дедлайнов  

🔔 Уведомления  
• напоминания сотрудникам: 24 ч / 6 ч / 2 ч  
• оповещения владельцу о просрочках  

⚙️ Автоматизация  
• проверка дедлайнов – каждые 30 мин  
• авто-назначение исполнителей  
`, {
    parse_mode: 'Markdown'
  });
});

workBot.onText(/\/link/, async (msg) => {
  const link = await fetchMainInviteLink(workBot, msg.chat.id);
  console.log(link); // если нужно – отправьте пользователю
});

// ─── публичная /chatinfo ─────────────────────────────────────────────────────
workBot.onText(/\/chatinfo/, (msg) => {
  const chat = msg.chat;
  const info = `Информация о чате:

*ID:* \`${chat.id}\`
*Тип:* ${chat.type}
*Название:* ${chat.title || chat.first_name || '—'}
*Username:* @${chat.username || '—'}

${chat.type === 'group' ? 'Обычная группа' : ''}
${chat.type === 'supergroup' ? 'Супергруппа' : ''}
${chat.type === 'private' ? 'Личный чат' : ''}`;
  workBot.sendMessage(chat.id, info, { parse_mode: 'Markdown' });
});

// ─── подключаем кастомные обработчики из ваших модулей ───────────────────────
commands.handleStartWithParam(workBot, userStates);
commands.handleStart(workBot);
commands.handleCreateTask(workBot, userStates, taskCreationSessions);
commands.handleMyTasks(workBot);
commands.handleSearchTasks(workBot, userStates);
commands.handleDone(workBot, userStates);
commands.handleHelp(workBot);

messages.handleMessages(workBot, userStates, taskCreationSessions, openai);
messages.handleVoiceMessages(workBot, userStates, taskCreationSessions, openai);
messages.handleDocuments(workBot, userStates, taskCreationSessions);
messages.handlePhotos(workBot, userStates, taskCreationSessions);

callbacks.handleCallbacks(workBot, userStates, taskCreationSessions);

// ─── служебные задачи ────────────────────────────────────────────────────────
setInterval(() => cleanupUserStates(userStates), 60 * 60 * 1000);

// ─── обработка ошибок ────────────────────────────────────────────────────────
workBot.on('polling_error', err => console.error('Polling:', err));
workBot.on('error', err => console.error('Bot:', err));
process.on('uncaughtException', err => {
  console.error('Uncaught:', err);
  Object.keys(userStates).forEach(id => delete userStates[id]);
});

// ─── graceful shutdown ───────────────────────────────────────────────────────
['SIGINT', 'SIGTERM'].forEach(sig => {
  process.once(sig, () => {
    console.log('Stopping bot...');
    workBot.stopPolling();
    process.exit(0);
  });
});

// ─── запуск HTTP-сервера ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server & bots running on :${PORT}`));
