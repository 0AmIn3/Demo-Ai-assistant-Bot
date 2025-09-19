const cron = require('node-cron');
const { loadDB, saveDB } = require('../../database/db');
const { getOwnerUsername, OWNER_USERNAME  } = require('../../config/constants');
const plankaService = require('../services/plankaService');
const { escapeMarkdown } = require('../utils/helpers');
const axios = require('axios');

class DeadlineScheduler {
  constructor(bot) {
    this.bot = bot;
    this.init();
  }

  init() {
    // Проверяем дедлайны каждые 30 минут
    cron.schedule('*/30 * * * *', () => {
      this.checkDeadlines();
    });

    // Ежедневная проверка в 9:00 по Ташкенту (4:00 UTC)
    cron.schedule('0 4 * * *', () => {
      this.checkDailyDeadlines();
    });

    console.log('📅 Планировщик дедлайнов запущен');
  }

  async checkDeadlines() {
    try {
      const tasks = await this.getAllTasksWithDeadlines();
      const now = new Date();

      for (const task of tasks) {
        const dueDate = new Date(task.dueDate);
        const timeDiff = dueDate.getTime() - now.getTime();
        const hoursDiff = timeDiff / (1000 * 60 * 60);

        // Уведомления для сотрудников
        if (hoursDiff <= 24 && hoursDiff > 0) {
          await this.notifyEmployeeAboutDeadline(task, hoursDiff);
        }

        // Уведомления для владельца о просроченных задачах
        if (hoursDiff <= 0) {
          await this.notifyOwnerAboutOverdue(task, Math.abs(hoursDiff));
        }
      }
    } catch (error) {
      console.error('Ошибка проверки дедлайнов:', error);
    }
  }

  async checkDailyDeadlines() {
    try {
      const tasks = await this.getAllTasksWithDeadlines();
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todayTasks = tasks.filter(task => {
        const dueDate = new Date(task.dueDate);
        return dueDate.toDateString() === today.toDateString();
      });

      const tomorrowTasks = tasks.filter(task => {
        const dueDate = new Date(task.dueDate);
        return dueDate.toDateString() === tomorrow.toDateString();
      });

      // Уведомляем о задачах на сегодня
      if (todayTasks.length > 0) {
        await this.sendDailyDigest(todayTasks, 'сегодня');
      }

      // Уведомляем о задачах на завтра
      if (tomorrowTasks.length > 0) {
        await this.sendDailyDigest(tomorrowTasks, 'завтра');
      }
    } catch (error) {
      console.error('Ошибка ежедневной проверки:', error);
    }
  }

  async getAllTasksWithDeadlines() {
    try {
      const accessToken = await plankaService.getPlankaAccessToken();
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
        }));
    } catch (error) {
      console.error('Ошибка получения задач с дедлайнами:', error);
      return [];
    }
  }

  async notifyEmployeeAboutDeadline(task, hoursLeft) {
    try {
      const db = loadDB();
      const key = `deadline_${task.id}_${Math.floor(hoursLeft)}h`;

      // Проверяем, не отправляли ли уже это уведомление
      if (db.sentNotifications && db.sentNotifications.includes(key)) {
        return;
      }

      for (const assigneeId of task.assignees) {
        const employee = db.employees.find(emp => emp.plankaUserId === assigneeId);
        if (!employee || !employee.userId) continue;

        const dueDate = new Date(task.dueDate);
        const timeLeft = this.formatTimeLeft(hoursLeft);

        let urgencyEmoji = '⏰';
        if (hoursLeft <= 2) urgencyEmoji = '🚨';
        else if (hoursLeft <= 6) urgencyEmoji = '⚠️';

        const message =
          `${urgencyEmoji} *Напоминание о дедлайне!*\n\n` +
          `📋 *Задача:* ${escapeMarkdown(task.name)}\n` +
          `⏰ *Осталось времени:* ${timeLeft}\n` +
          `📅 *Дедлайн:* ${dueDate.toLocaleString('ru-RU')}\n` +
          `🔗 *Ссылка:* https://swifty.uz/cards/${task.id}`;

        await this.bot.sendMessage(employee.userId, message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[
              { text: '👁 Посмотреть задачу', callback_data: `view_task_${task.id}` }
            ]]
          }
        });
      }

      // Сохраняем факт отправки уведомления
      if (!db.sentNotifications) db.sentNotifications = [];
      db.sentNotifications.push(key);

      // Очищаем старые уведомления (старше 7 дней)
      const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
      db.sentNotifications = db.sentNotifications.filter(notif => {
        const timestamp = notif.split('_').pop();
        return timestamp && parseInt(timestamp) > weekAgo;
      });

      saveDB(db);
    } catch (error) {
      console.error('Ошибка уведомления сотрудника о дедлайне:', error);
    }
  }

  async notifyOwnerAboutOverdue(task, hoursOverdue) {
    try {
      const db = loadDB();
      const key = `overdue_${task.id}_${Math.floor(hoursOverdue / 24)}d`;

      // Уведомляем владельца только раз в день о просроченной задаче
      if (db.sentNotifications && db.sentNotifications.includes(key)) {
        return;
      }

      const ownerEmployee = db.employees.find(emp => emp.username === (getOwnerUsername(null) || OWNER_USERNAME));
      if (!ownerEmployee || !ownerEmployee.userId) return;

      const dueDate = new Date(task.dueDate);
      const overdueTime = this.formatTimeLeft(hoursOverdue);

      // Получаем информацию об исполнителях
      const assigneeNames = [];
      for (const assigneeId of task.assignees) {
        const employee = db.employees.find(emp => emp.plankaUserId === assigneeId);
        if (employee) assigneeNames.push(employee.name);
      }

      const message =
        `🚨 *ПРОСРОЧЕННАЯ ЗАДАЧА!*\n\n` +
        `📋 *Задача:* ${escapeMarkdown(task.name)}\n` +
        `⏰ *Просрочена на:* ${overdueTime}\n` +
        `📅 *Дедлайн был:* ${dueDate.toLocaleString('ru-RU')}\n` +
        `👥 *Исполнители:* ${assigneeNames.join(', ') || 'Не назначены'}\n` +
        `🔗 *Ссылка:* https://swifty.uz/cards/${task.id}`;

      await this.bot.sendMessage(ownerEmployee.userId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: '👁 Посмотреть задачу', callback_data: `edit_task_${task.id}` }], // Владелец может редактировать
            [{ text: '⏰ Продлить дедлайн', callback_data: `edit_duedate_${task.id}` }],
          ]
        }
      });

      // Сохраняем факт отправки уведомления
      if (!db.sentNotifications) db.sentNotifications = [];
      db.sentNotifications.push(key);
      saveDB(db);
    } catch (error) {
      console.error('Ошибка уведомления владельца о просрочке:', error);
    }
  }

  async sendDailyDigest(tasks, period) {
    try {
      const db = loadDB();
      const ownerEmployee = db.employees.find(emp => emp.username === (getOwnerUsername(null) || OWNER_USERNAME));
      if (!ownerEmployee || !ownerEmployee.userId) return;

      let message = `📅 *Задачи на ${period}* (${tasks.length})\n\n`;

      for (const [index, task] of tasks.entries()) {
        const dueDate = new Date(task.dueDate);
        const timeStr = dueDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

        message += `${index + 1}. ${escapeMarkdown(task.name)}\n`;
        message += `   ⏰ ${timeStr}\n\n`;
      }

      await this.bot.sendMessage(ownerEmployee.userId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '📊 Показать статистику', callback_data: 'show_statistics' }
          ]]
        }
      });
    } catch (error) {
      console.error('Ошибка отправки ежедневного дайджеста:', error);
    }
  }

  formatTimeLeft(hours) {
    if (hours < 1) {
      const minutes = Math.floor(hours * 60);
      return `${minutes} минут`;
    } else if (hours < 24) {
      const h = Math.floor(hours);
      const m = Math.floor((hours - h) * 60);
      return `${h}ч ${m}м`;
    } else {
      const days = Math.floor(hours / 24);
      const remainingHours = Math.floor(hours % 24);
      return `${days}д ${remainingHours}ч`;
    }
  }
}

module.exports = DeadlineScheduler;