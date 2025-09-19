const axios = require('axios');
const { loadDB } = require('../../database/db');
const plankaService = require('./plankaService');
const { escapeMarkdown } = require('../utils/helpers');

class StatisticsService {
  async generateStatistics(period = '30d', chatId, msgId, bot) {
    try {
      const stats = await this.collectStatistics(period);
      const message = this.formatStatisticsMessage(stats, period);

      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {  // та же клавиатура, что была
          inline_keyboard: [
            [
              { text: '📊 7 дней', callback_data: 'stats_7d' },
              { text: '📊 30 дней', callback_data: 'stats_30d' }
            ],
            [
              { text: '📊 90 дней', callback_data: 'stats_90d' },
              { text: '📊 Весь период', callback_data: 'stats_all' }
            ],
            [
              { text: '👥 Статистика по сотрудникам', callback_data: 'employee_stats' }
            ],
            [
              { text: '⚠️ Проблемные задачи', callback_data: 'problem_tasks' }
            ]
          ]
        }
      };

      if (msgId) {
        await bot.editMessageText(message, { chat_id: chatId, message_id: msgId, ...opts });
      } else {
        await bot.sendMessage(chatId, message, opts);
      }

    } catch (e) {
      console.error('generateStatistics:', e);
      await this.safeReply(bot, chatId, msgId, '❌ Ошибка при формировании статистики');
    }
  }

  async collectStatistics(period) {
    const tasks = await this.getAllTasks();
    const db = loadDB();
    const employees = db.employees || [];

    const periodMs = this.getPeriodMs(period);
    const cutoffDate = period === 'all' ? new Date(0) : new Date(Date.now() - periodMs);

    // Фильтруем задачи по периоду
    const periodTasks = tasks.filter(task => {
      const createdDate = new Date(task.createdAt);
      return createdDate >= cutoffDate;
    });

    const completedTasks = periodTasks.filter(task => this.isTaskCompleted(task));
    const overdueTasks = periodTasks.filter(task => this.isTaskOverdue(task));
    const activeTasks = periodTasks.filter(task => !this.isTaskCompleted(task) && !this.isTaskOverdue(task));

    // Статистика по приоритетам
    const priorityStats = await this.calculatePriorityStats(periodTasks);

    // Статистика по исполнителям
    const employeeStats = await this.calculateEmployeeStats(periodTasks, employees);

    // Среднее время выполнения
    const avgCompletionTime = this.calculateAverageCompletionTime(completedTasks);

    // Статистика по спискам (статусам)
    const listStats = await this.calculateListStats(periodTasks);

    return {
      period,
      totalTasks: periodTasks.length,
      completedTasks: completedTasks.length,
      activeTasks: activeTasks.length,
      overdueTasks: overdueTasks.length,
      completionRate: periodTasks.length > 0 ? (completedTasks.length / periodTasks.length * 100).toFixed(1) : 0,
      avgCompletionTime,
      priorityStats,
      employeeStats,
      listStats,
      overdueDetails: overdueTasks.slice(0, 5) // Показываем топ 5 просроченных
    };
  }

  async getAllTasks() {
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
      const lists = response.data.included.lists || [];
      const cardLabels = response.data.included.cardLabels || [];
      const labels = response.data.included.labels || [];

      return cards.map(card => ({
        ...card,
        assignees: cardMemberships
          .filter(membership => membership.cardId === card.id)
          .map(membership => membership.userId),
        listName: lists.find(list => list.id === card.listId)?.name || 'Неизвестно',
        labels: cardLabels
          .filter(cl => cl.cardId === card.id)
          .map(cl => labels.find(l => l.id === cl.labelId)?.name)
          .filter(Boolean)
      }));
    } catch (error) {
      console.error('Ошибка получения задач для статистики:', error);
      return [];
    }
  }

  isTaskCompleted(task) {
    const completedStatuses = ['Готово', 'Выполнено', 'Done', 'Completed', 'Завершено'];
    return completedStatuses.some(status =>
      task.listName.toLowerCase().includes(status.toLowerCase())
    );
  }

  isTaskOverdue(task) {
    if (this.isTaskCompleted(task)) return false;

    if (!task.dueDate || task.isDueDateCompleted) return false;
    return new Date(task.dueDate) < new Date();
  }

  async calculatePriorityStats(tasks) {
    const priorityMap = {
      'Высокий': 0,
      'Средний': 0,
      'Низкий': 0,
      'Без приоритета': 0
    };

    tasks.forEach(task => {
      const hasHighPriority = task.labels.some(label =>
        ['высокий', 'high', 'срочно', 'urgent', 'критический', 'critical'].some(p =>
          label.toLowerCase().includes(p)
        )
      );
      const hasLowPriority = task.labels.some(label =>
        ['низкий', 'low'].some(p => label.toLowerCase().includes(p))
      );
      const hasMediumPriority = task.labels.some(label =>
        ['средний', 'medium', 'normal'].some(p => label.toLowerCase().includes(p))
      );

      if (hasHighPriority) priorityMap['Высокий']++;
      else if (hasLowPriority) priorityMap['Низкий']++;
      else if (hasMediumPriority) priorityMap['Средний']++;
      else priorityMap['Без приоритета']++;
    });

    return priorityMap;
  }

  async calculateEmployeeStats(tasks, employees) {
    const employeeMap = {};

    employees.forEach(emp => {
      employeeMap[emp.plankaUserId] = {
        name: emp.name,
        totalTasks: 0,
        completedTasks: 0,
        overdueTasks: 0
      };
    });

    tasks.forEach(task => {
      task.assignees.forEach(assigneeId => {
        if (employeeMap[assigneeId]) {
          employeeMap[assigneeId].totalTasks++;
          if (this.isTaskCompleted(task)) {
            employeeMap[assigneeId].completedTasks++;
          }
          if (this.isTaskOverdue(task)) {
            employeeMap[assigneeId].overdueTasks++;
          }
        }
      });
    });

    // Сортируем по количеству выполненных задач
    return Object.values(employeeMap)
      .filter(emp => emp.totalTasks > 0)
      .sort((a, b) => b.completedTasks - a.completedTasks);
  }

  calculateAverageCompletionTime(completedTasks) {
    if (completedTasks.length === 0) return 'Нет данных';

    const totalTime = completedTasks.reduce((sum, task) => {
      const created = new Date(task.createdAt);
      const updated = new Date(task.updatedAt);
      return sum + (updated - created);
    }, 0);

    const avgMs = totalTime / completedTasks.length;
    const avgDays = Math.round(avgMs / (1000 * 60 * 60 * 24));
    return `${avgDays} дней`;
  }

  async calculateListStats(tasks) {
    const listMap = {};

    tasks.forEach(task => {
      if (!listMap[task.listName]) {
        listMap[task.listName] = 0;
      }
      listMap[task.listName]++;
    });

    return listMap;
  }

  formatStatisticsMessage(stats, period) {
    const periodText = {
      '7d': '7 дней',
      '30d': '30 дней',
      '90d': '90 дней',
      'all': 'весь период'
    }[period] || period;

    let message = `📊 *Статистика за ${periodText}*\n\n`;

    // Общая статистика
    message += `📋 *Общие показатели:*\n`;
    message += `• Всего задач: ${stats.totalTasks}\n`;
    message += `• Выполнено: ${stats.completedTasks} (${stats.completionRate}%)\n`;
    message += `• В работе: ${stats.listStats['В работе']}\n`;
    message += `• Просрочено: ${stats.overdueTasks}\n`;
    message += `• Среднее время выполнения: ${stats.avgCompletionTime}\n\n`;

    // Статистика по приоритетам
    message += `⚡ *По приоритетам:*\n`;
    Object.entries(stats.priorityStats).forEach(([priority, count]) => {
      if (count > 0) {
        message += `• ${priority}: ${count}\n`;
      }
    });
    message += '\n';

    // Топ исполнителей
    if (stats.employeeStats.length > 0) {
      message += `👥 *Топ исполнителей:*\n`;
      stats.employeeStats.slice(0, 5).forEach((emp, index) => {
        const completionRate = emp.totalTasks > 0 ?
          Math.round(emp.completedTasks / emp.totalTasks * 100) : 0;
        message += `${index + 1}. ${escapeMarkdown(emp.name)}: ${emp.completedTasks}/${emp.totalTasks} (${completionRate}%)\n`;
      });
      message += '\n';
    }

    // Статистика по спискам
    message += `📂 *По статусам:*\n`;
    Object.entries(stats.listStats).forEach(([listName, count]) => {
      message += `• ${escapeMarkdown(listName)}: ${count}\n`;
    });

    return message;
  }

  async generateEmployeeStats(chatId, msgId, bot) {
    try {
      const tasks = await this.getAllTasks();
      const employees = loadDB().employees || [];
      const empStats = await this.calculateEmployeeStats(tasks, employees);

      let message = '👥 *Детальная статистика по сотрудникам*\n\n';
      if (empStats.length === 0) {
        message += 'Нет данных по сотрудникам';
      } else {
        empStats.forEach((emp, i) => {
          const rate = emp.totalTasks ? Math.round(emp.completedTasks / emp.totalTasks * 100) : 0;
          message += `${i + 1}. *${escapeMarkdown(emp.name)}*\n` +
            `   📋 Всего: ${emp.totalTasks}\n` +
            `   ✅ Выполнено: ${emp.completedTasks} (${rate}%)\n` +
            `   ⚠️ Просрочено: ${emp.overdueTasks}\n\n`;
        });
      }

      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Назад к статистике', callback_data: 'show_statistics' }
          ]]
        }
      };

      if (msgId) {
        await bot.editMessageText(message, { chat_id: chatId, message_id: msgId, ...opts });
      } else {
        await bot.sendMessage(chatId, message, opts);
      }
    } catch (error) {
      console.error('generateEmployeeStats:', e);
      await this.safeReply(bot, chatId, msgId, '❌ Ошибка при формировании статистики по сотрудникам');
    }
  }

  async generateProblemTasks(chatId, msgId, bot) {
    try {
      const tasks = await this.getAllTasks();
      const overdueTasks = tasks.filter(t => this.isTaskOverdue(t));
      const db = loadDB();

      let message = '⚠️ *Проблемные задачи*\n\n';
      if (overdueTasks.length === 0) {
        message += '✅ Просроченных задач нет!';
      } else {
        message += `Найдено просроченных задач: ${overdueTasks.length}\n\n`;
        overdueTasks.slice(0, 10).forEach((t, i) => {
          const days = Math.floor((Date.now() - new Date(t.dueDate)) / 86400000);
          const names = t.assignees
            .map(id => db.employees.find(e => e.plankaUserId === id)?.name || 'Неизвестный')
            .join(', ') || 'Не назначены';
          message += `${i + 1}. *${escapeMarkdown(t.name)}*\n` +
            `   📅 Просрочено на: ${days} дн.\n` +
            `   👤 Исполнители: ${names}\n` +
            `   📂 Статус: ${escapeMarkdown(t.listName)}\n\n`;
        });
        if (overdueTasks.length > 10) {
          message += `…и ещё ${overdueTasks.length - 10} задач`;
        }
      }

      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔙 Назад к статистике', callback_data: 'show_statistics' }
          ]]
        }
      };

      if (msgId) {
        await bot.editMessageText(message, { chat_id: chatId, message_id: msgId, ...opts });
      } else {
        await bot.sendMessage(chatId, message, opts);
      }
    } catch (error) {
      console.error('generateProblemTasks:', e);
      await this.safeReply(bot, chatId, msgId, '❌ Ошибка при формировании списка проблемных задач');
    }
  }
  async safeReply(bot, chatId, msgId, text) {
    if (msgId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId });
    } else {
      await bot.sendMessage(chatId, text);
    }
  }
  getPeriodMs(period) {
    const periods = {
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
      '90d': 90 * 24 * 60 * 60 * 1000
    };
    return periods[period] || periods['30d'];
  }
}

module.exports = new StatisticsService();