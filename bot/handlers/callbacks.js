const { loadDB, saveDB } = require('../../database/db');
const { OWNER_USERNAME } = require('../../config/constants');
const { createAssigneeKeyboard } = require('../utils/keyboards');
const taskService = require('../services/taskService');
const { escapeMarkdown } = require('../utils/helpers');
const statisticsService = require('../services/statisticsService');
// Обработка callback запросов
function handleCallbacks(bot, userStates, taskCreationSessions) {
  bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const username = callbackQuery.from.username;
    const data = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;

    // Находим активную сессию
    const sessionId = Object.keys(taskCreationSessions).find(id =>
      taskCreationSessions[id].chatId === chatId &&
      taskCreationSessions[id].userId === userId
    );
    if (data === 'show_statistics') {
      if (username !== OWNER_USERNAME) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
        return;
      }

      await statisticsService.generateStatistics('30d', chatId, bot);
      await bot.answerCallbackQuery(callbackQuery.id);
      return;
    }
    try {
      if (data.startsWith('stats_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const period = data.replace('stats_', '');
        await statisticsService.generateStatistics(period, chatId, bot);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Статистика по сотрудникам
      if (data === 'employee_stats') {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        await statisticsService.generateEmployeeStats(chatId, bot);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Проблемные задачи
      if (data === 'problem_tasks') {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        await statisticsService.generateProblemTasks(chatId, bot);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }
      // Обработка специальных callback'ов
      if (data === 'show_my_tasks') {
        await taskService.showUserTasks(userId, chatId, bot);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }
      // Выбор группы для создания задачи
      if (data.startsWith('select_group_')) {
        const parts = data.split('_');
        const sessionId = parts[2];
        const groupId = parts[3];

        if (!taskCreationSessions[sessionId]) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: 'Сессия создания задачи истекла' });
          return;
        }

        const session = taskCreationSessions[sessionId];
        session.targetGroupId = groupId;

        // Пытаемся найти исполнителя в выбранной группе
        let autoAssignedEmployee = null;
        let assigneeNotFoundMessage = null;

        if (session.analysis.assigneeInfo && session.analysis.assigneeInfo.mentioned) {
          autoAssignedEmployee = findAssigneeInDatabase(session.analysis.assigneeInfo, groupId);

          if (!autoAssignedEmployee) {
            assigneeNotFoundMessage = createAssigneeNotFoundMessage(session.analysis.assigneeInfo);
          }
        }

        session.autoAssignedEmployee = autoAssignedEmployee;
        session.assigneeNotFoundMessage = assigneeNotFoundMessage;

        // Получаем списки из Planka
        const lists = await plankaService.getPlankaLists();
        if (lists.length === 0) {
          await bot.editMessageText('❌ Не удалось получить списки из Planka.', {
            chat_id: chatId,
            message_id: messageId
          });
          await bot.answerCallbackQuery(callbackQuery.id);
          return;
        }

        // Обновляем сообщение с выбором статуса
        const escapedTitle = escapeMarkdown(session.analysis.title);
        const escapedDescription = escapeMarkdown(session.analysis.description);
        const escapedPriority = escapeMarkdown(session.analysis.priority);

        let messageText = `🎯 Создание задачи:\n\n` +
          `📝 Название: *${escapedTitle}*\n` +
          `📋 Описание: ${escapedDescription}\n` +
          `⚡ Приоритет: ${escapedPriority}\n`;

        if (autoAssignedEmployee) {
          messageText += `\n${createAssigneeFoundMessage(autoAssignedEmployee, session.analysis.assigneeInfo)}\n`;
        } else if (session.analysis.assigneeInfo && session.analysis.assigneeInfo.mentioned) {
          messageText += `\n❓ Исполнитель упомянут, но не найден автоматически\n`;
        }

        messageText += `\nВыберите статус для задачи:`;

        await bot.editMessageText(messageText, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          reply_markup: createListSelectionKeyboard(lists)
        });

        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }
      // Просмотр задачи
      if (data.startsWith('view_task_')) {
        const cardId = data.replace('view_task_', '');
        await taskService.showTaskDetails(cardId, chatId, userId, false, bot);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Редактирование задачи (только для владельца)
      if (data.startsWith('edit_task_')) {
        // Проверяем права доступа
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав для редактирования' });
          return;
        }

        const cardId = data.replace('edit_task_', '');
        await taskService.showTaskDetails(cardId, chatId, userId, true, bot);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Перемещение карточки пользователем
      if (data.startsWith('move_card_')) {
        const [, cardId, listId] = data.split('_').slice(1);

        try {
          const plankaService = require('../services/plankaService');
          await plankaService.moveCard(cardId, listId);

          // Получаем название нового списка
          const lists = await plankaService.getPlankaLists();
          const targetList = lists.find(list => list.id === listId);
          const listName = targetList?.name || 'Неизвестный статус';

          // Удаляем старое сообщение и отправляем новое об успешном изменении
          await bot.editMessageText(
            `✅ Задача перемещена в статус "${listName}"`,
            {
              chat_id: chatId,
              message_id: messageId
            }
          );

        } catch (error) {
          console.error('Ошибка перемещения карточки:', error);
          await bot.editMessageText(
            '❌ Ошибка при перемещении задачи',
            {
              chat_id: chatId,
              message_id: messageId
            }
          );
        }

        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Обновление информации о задаче
      if (data.startsWith('refresh_task_')) {
        const cardId = data.replace('refresh_task_', '');
        await taskService.showTaskDetails(cardId, chatId, userId, false, bot);
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🔄 Обновлено' });
        return;
      }

      // Редактирование названия
      if (data.startsWith('edit_name_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const cardId = data.replace('edit_name_', '');
        userStates[userId] = {
          state: 'editing_task',
          step: 'edit_name',
          cardId: cardId
        };

        await bot.sendMessage(chatId, '✏️ Введите новое название задачи:', {
          reply_markup: {
            inline_keyboard: [[
              { text: '❌ Отмена', callback_data: `cancel_edit_name_${cardId}` }
            ]]
          }
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Редактирование описания
      if (data.startsWith('edit_desc_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const cardId = data.replace('edit_desc_', '');
        userStates[userId] = {
          state: 'editing_task',
          step: 'edit_description',
          cardId: cardId
        };

        await bot.sendMessage(chatId, '📝 Введите новое описание задачи:', {
          reply_markup: {
            inline_keyboard: [[
              { text: '❌ Отмена', callback_data: `cancel_edit_desc_${cardId}` }
            ]]
          }
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Управление файлами
      if (data.startsWith('manage_files_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const cardId = data.replace('manage_files_', '');
        await taskService.showFileManagement(cardId, chatId, messageId, bot);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Перемещение задачи владельцем
      if (data.startsWith('move_task_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const cardId = data.replace('move_task_', '');
        await taskService.showMoveTaskOptions(cardId, chatId, messageId, bot);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Удаление задачи
      if (data.startsWith('delete_task_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const cardId = data.replace('delete_task_', '');
        await bot.editMessageText(
          '⚠️ Вы уверены, что хотите удалить эту задачу?\n\nЭто действие нельзя отменить!',
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Да, удалить', callback_data: `confirm_delete_${cardId}` },
                  { text: '❌ Отмена', callback_data: `cancel_delete_${cardId}` }
                ]
              ]
            }
          }
        );
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Подтверждение удаления
      if (data.startsWith('confirm_delete_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const cardId = data.replace('confirm_delete_', '');
        await taskService.deleteTask(cardId, chatId, messageId, bot);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Отмена удаления
      if (data.startsWith('cancel_delete_')) {
        const cardId = data.replace('cancel_delete_', '');
        await taskService.showTaskDetails(cardId, chatId, userId, true, bot);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Удаление отменено' });
        return;
      }

      // Перемещение в конкретный статус (владельцем)
      if (data.startsWith('owner_move_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const [cardId, listId] = data.split('_').slice(2);

        try {
          const plankaService = require('../services/plankaService');
          await plankaService.moveCard(cardId, listId);

          // Получаем название нового списка
          const lists = await plankaService.getPlankaLists();
          const targetList = lists.find(list => list.id === listId);
          const listName = targetList?.name || 'Неизвестный статус';

          // Заменяем сообщение на уведомление об успешном изменении
          await bot.editMessageText(
            `✅ Задача успешно перемещена в статус "${listName}"`,
            {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: {
                inline_keyboard: [[
                  { text: '👁 Посмотреть задачу', callback_data: `edit_task_${cardId}` }
                ]]
              }
            }
          );
        } catch (error) {
          console.error('Ошибка перемещения карточки:', error);
          await bot.editMessageText(
            '❌ Ошибка при перемещении задачи',
            {
              chat_id: chatId,
              message_id: messageId
            }
          );
        }

        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Закрытие задачи (удаление сообщения)
      if (data.startsWith('close_task_')) {
        try {
          await bot.deleteMessage(chatId, messageId);
        } catch (error) {
          console.error('Ошибка удаления сообщения:', error);
          // Если не удалось удалить, заменяем на простое сообщение
          await bot.editMessageText(
            '✅ Действия отменены',
            {
              chat_id: chatId,
              message_id: messageId
            }
          );
        }
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Добавление файлов к задаче
      if (data.startsWith('add_file_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const cardId = data.replace('add_file_', '');
        userStates[userId] = {
          state: 'adding_files',
          cardId: cardId,
          attachments: []
        };

        await bot.sendMessage(chatId,
          '📎 Отправьте файлы для добавления к задаче.\n\n' +
          'После загрузки всех файлов используйте команду /done',
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '❌ Отмена', callback_data: `cancel_add_file_${cardId}` }
              ]]
            }
          }
        );
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Удаление файла
      if (data.startsWith('delete_file_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const attachmentId = data.replace('delete_file_', '');
        await taskService.deleteAttachmentTask(attachmentId, chatId, bot);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Возврат к управлению файлами
      if (data.startsWith('back_to_files_')) {
        const cardId = data.replace('back_to_files_', '');
        await taskService.showFileManagement(cardId, chatId, messageId, bot);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }
      // Отмена редактирования названия
      if (data.startsWith('cancel_edit_name_')) {
        const cardId = data.replace('cancel_edit_name_', '');
        delete userStates[userId];
        await bot.sendMessage(chatId, '❌ Редактирование названия отменено');
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Отмена редактирования описания
      if (data.startsWith('cancel_edit_desc_')) {
        const cardId = data.replace('cancel_edit_desc_', '');
        delete userStates[userId];
        await bot.sendMessage(chatId, '❌ Редактирование описания отменено');
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Отмена добавления файлов
      if (data.startsWith('cancel_add_file_')) {
        const cardId = data.replace('cancel_add_file_', '');
        delete userStates[userId];
        await bot.sendMessage(chatId, '❌ Добавление файлов отменено');
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }
      // Возврат к деталям задачи
      if (data.startsWith('back_to_task_')) {
        const cardId = data.replace('back_to_task_', '');

        try {
          const plankaService = require('../services/plankaService');
          const card = await plankaService.getCard(cardId);
          if (!card) {
            await bot.editMessageText('❌ Задача не найдена', {
              chat_id: chatId,
              message_id: messageId
            });
            await bot.answerCallbackQuery(callbackQuery.id);
            return;
          }

          const lists = await plankaService.getPlankaLists();
          const targetList = lists.find(list => list.id === card.listId);
          const listName = targetList?.name || 'Неизвестный статус';

          let message =
            `📋 *${escapeMarkdown(card.name)}*\n\n` +
            `📝 Описание: ${escapeMarkdown(card.description || 'Нет описания')}\n` +
            `📂 Статус: ${escapeMarkdown(listName)}\n` +
            `🔗 Ссылка на карточку: https://swifty.uz/cards/${cardId}\n`;

          if (card.dueDate) {
            const dueDate = new Date(card.dueDate);
            const now = new Date();
            const isOverdue = dueDate < now;
            const dateStr = dueDate.toLocaleDateString('ru-RU');
            const timeStr = dueDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

            if (isOverdue) {
              message += `⏰ *Срок (просрочен):* ${dateStr} ${timeStr}\n`;
            } else {
              message += `📅 *Срок выполнения:* ${dateStr} ${timeStr}\n`;
            }
          }

          // Формируем клавиатуру в зависимости от роли пользователя
          let keyboard = [];
          const isOwner = username === OWNER_USERNAME;

          if (isOwner) {
            // Клавиатура для владельца (редактирование)
            keyboard = [
              [{ text: '✏️ Изменить название', callback_data: `edit_name_${cardId}` }],
              [{ text: '📝 Изменить описание', callback_data: `edit_desc_${cardId}` }],
              [{ text: '⚡ Изменить приоритет', callback_data: `edit_priority_${cardId}` }],
              [{ text: '⏰ Изменить срок', callback_data: `edit_duedate_${cardId}` }],
              [{ text: '📎 Управление файлами', callback_data: `manage_files_${cardId}` }],
              [{ text: '🔄 Изменить статус', callback_data: `move_task_${cardId}` }],
              [{ text: '🗑 Удалить задачу', callback_data: `delete_task_${cardId}` }],
              [{ text: '❌ Отменить действия', callback_data: `close_task_${cardId}` }]
            ];
          } else {
            // Клавиатура для обычного пользователя (смена статуса)
            keyboard = lists.map(list => ([{
              text: `➡️ ${list.name}`,
              callback_data: `move_card_${cardId}_${list.id}`
            }]));

            keyboard.unshift([{
              text: '🔄 Обновить информацию',
              callback_data: `refresh_task_${cardId}`
            }]);

            keyboard.push([{
              text: '❌ Закрыть',
              callback_data: `close_task_${cardId}`
            }]);
          }

          await bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: keyboard }
          });

        } catch (error) {
          console.error('Ошибка получения информации о задаче:', error);
          await bot.editMessageText('❌ Ошибка при получении информации о задаче', {
            chat_id: chatId,
            message_id: messageId
          });
        }

        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }
      // запрос нового приоритета
      if (data.startsWith('edit_priority_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const cardId = data.replace('edit_priority_', '');

        try {
          // Получаем доступные лейблы приоритетов
          const plankaService = require('../services/plankaService');
          const boardLabels = await plankaService.getBoardLabels();
          const priorityLabels = boardLabels.filter(label =>
            ['высокий', 'средний', 'низкий', 'high', 'medium', 'low', 'срочно', 'urgent', 'critical', 'критический'].some(priority =>
              label.name.toLowerCase().includes(priority)
            )
          );

          if (priorityLabels.length === 0) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Нет доступных лейблов приоритета' });
            return;
          }

          // Создаем клавиатуру с доступными приоритетами
          const priorityKeyboard = priorityLabels.map(label => ([{
            text: `⚡ ${label.name}`,
            callback_data: `set_priority_${cardId}_${label.id}`
          }]));

          priorityKeyboard.push([{
            text: '❌ Отмена',
            callback_data: `cancel_edit_priority_${cardId}`
          }]);

          await bot.editMessageText(
            '⚡ Выберите новый приоритет:',
            {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: { inline_keyboard: priorityKeyboard }
            }
          );

        } catch (error) {
          console.error('Ошибка получения лейблов:', error);
          const prompt = await bot.sendMessage(chatId, '⚡ Введите новый приоритет (high/medium/low):', {
            reply_markup: {
              inline_keyboard: [[{ text: '❌ Отмена', callback_data: `cancel_edit_priority_${cardId}` }]]
            }
          });
          userStates[userId] = {
            state: 'editing_task',
            step: 'edit_priority',
            cardId,
            promptMessageId: prompt.message_id
          };
        }

        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }
      // Добавьте новый обработчик для установки приоритета через лейбл:
      if (data.startsWith('set_priority_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const parts = data.split('_');
        const cardId = parts[2];
        const labelId = parts[3];

        try {
          const plankaService = require('../services/plankaService');

          // Получаем текущие лейблы карточки
          const currentLabels = await plankaService.getCardLabels(cardId);

          // Удаляем все старые лейблы приоритета
          const boardLabels = await plankaService.getBoardLabels();
          const priorityLabels = boardLabels.filter(label =>
            ['высокий', 'средний', 'низкий', 'high', 'medium', 'low', 'срочно', 'urgent', 'critical', 'критический'].some(priority =>
              label.name.toLowerCase().includes(priority)
            )
          );

          for (const currentLabel of currentLabels) {
            const isPriorityLabel = priorityLabels.some(pLabel => pLabel.id === currentLabel.labelId);
            if (isPriorityLabel) {
              try {
                await plankaService.removeLabelFromCard(cardId, currentLabel.labelId);
              } catch (removeError) {
                console.error('Ошибка удаления старого лейбла:', removeError);
              }
            }
          }

          // Добавляем новый лейбл приоритета
          await plankaService.addLabelToCard(cardId, labelId);

          // Получаем название лейбла для отображения
          const newLabel = boardLabels.find(label => label.id === labelId);
          const labelName = newLabel ? newLabel.name : 'Неизвестный приоритет';

          await bot.editMessageText(
            `✅ Приоритет обновлён на "${labelName}"`,
            {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: {
                inline_keyboard: [[
                  { text: '👁 Посмотреть задачу', callback_data: `edit_task_${cardId}` }
                ]]
              }
            }
          );

        } catch (error) {
          console.error('Ошибка установки приоритета:', error);
          await bot.editMessageText(
            '❌ Ошибка при установке приоритета',
            {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: {
                inline_keyboard: [[
                  { text: '👁 Посмотреть задачу', callback_data: `edit_task_${cardId}` }
                ]]
              }
            }
          );
        }

        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }
      // отмена редактирования приоритета
      if (data.startsWith('cancel_edit_priority_')) {
        const promptId = userStates[userId]?.promptMessageId;
        if (promptId) {
          try {
            await bot.deleteMessage(chatId, promptId);
          } catch (error) {
            console.error('Ошибка удаления сообщения-подсказки:', error);
          }
        }
        delete userStates[userId];
        await bot.answerCallbackQuery(callbackQuery.id);
        await bot.sendMessage(chatId, '❌ Редактирование приоритета отменено');
        return;
      }


      // запрос нового срока выполнения
      if (data.startsWith('edit_duedate_')) {
        if (username !== OWNER_USERNAME) {
          await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Недостаточно прав' });
          return;
        }

        const cardId = data.replace('edit_duedate_', '');
        const prompt = await bot.sendMessage(chatId, '⏰ Введите новый срок в формате YYYY-MM-DD HH:MM:', {
          reply_markup: {
            inline_keyboard: [[{ text: '❌ Отмена', callback_data: `cancel_edit_duedate_${cardId}` }]]
          }
        });
        userStates[userId] = {
          state: 'editing_task',
          step: 'edit_duedate',
          cardId,
          promptMessageId: prompt.message_id
        };
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // отмена редактирования срока
      if (data.startsWith('cancel_edit_duedate_')) {
        const promptId = userStates[userId]?.promptMessageId;
        if (promptId) {
          try {
            await bot.deleteMessage(chatId, promptId);
          } catch (error) {
            console.error('Ошибка удаления сообщения-подсказки:', error);
          }
        }
        delete userStates[userId];
        await bot.answerCallbackQuery(callbackQuery.id);
        await bot.sendMessage(chatId, '❌ Редактирование срока выполнения отменено');
        return;
      }
      // Обработка сессий создания задач
      if (!sessionId) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Сессия создания задачи истекла' });
        return;
      }

      const session = taskCreationSessions[sessionId];

      // Отмена создания задачи
      if (data === 'cancel_task') {
        delete taskCreationSessions[sessionId];
        await bot.editMessageText('❌ Создание задачи отменено', {
          chat_id: chatId,
          message_id: messageId
        });
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }


      // Выбор списка
      // В функции callbacks выбора исполнителя заменяем:
      if (data.startsWith('select_list_')) {
        const listId = data.replace('select_list_', '');
        session.selectedListId = listId;

        // Проверяем, был ли автоматически назначен исполнитель
        if (session.autoAssignedEmployee) {
          // Пропускаем выбор исполнителя и переходим к файлам
          session.selectedAssigneeId = session.autoAssignedEmployee.plankaUserId;
          session.step = 'ask_files';

          await bot.editMessageText(
            `✅ Статус выбран!\n` +
            `👤 Исполнитель: ${session.autoAssignedEmployee.name}\n\n` +
            `Хотите прикрепить файлы к задаче?`,
            {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📎 Да, прикрепить файлы', callback_data: 'add_files' }],
                  [{ text: '✅ Нет, создать задачу', callback_data: 'create_task_now' }],
                  [{ text: '❌ Отмена', callback_data: 'cancel_task' }]
                ]
              }
            }
          );
        } else {
          // Обычный процесс выбора исполнителя ИЗ ВСЕХ СОТРУДНИКОВ
          session.step = 'select_assignee';

          // Получаем ВСЕХ сотрудников для выбора исполнителя
          const db = loadDB();
          const employees = db.employees || [];

          const messageText = session.assigneeNotFoundMessage ||
            `✅ Статус выбран!\n\nТеперь выберите исполнителя задачи:`;

          await bot.editMessageText(
            messageText,
            {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: createAssigneeKeyboard(employees)
            }
          );
        }

        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Выбор исполнителя
      if (data.startsWith('select_assignee_')) {
        const assigneeId = data.replace('select_assignee_', '');
        session.selectedAssigneeId = assigneeId === 'none' ? null : assigneeId;
        session.step = 'ask_files';

        await bot.editMessageText(
          `👤 Исполнитель выбран!\n\n` +
          `Хотите прикрепить файлы к задаче?`,
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [
                [{ text: '📎 Да, прикрепить файлы', callback_data: 'add_files' }],
                [{ text: '✅ Нет, создать задачу', callback_data: 'create_task_now' }],
                [{ text: '❌ Отмена', callback_data: 'cancel_task' }]
              ]
            }
          }
        );

        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Добавление файлов к новой задаче
      if (data === 'add_files') {
        session.step = 'waiting_files';
        session.attachments = [];

        await bot.editMessageText(
          `📎 Отправьте файлы для прикрепления к задаче.\n\n` +
          `После загрузки всех файлов нажмите "Готово"`,
          {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Готово', callback_data: 'create_task_now' }],
                [{ text: '❌ Отмена', callback_data: 'cancel_task' }]
              ]
            }
          }
        );

        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

      // Создание задачи
      if (data === 'create_task_now') {
        await taskService.createPlankaTask(session, chatId, messageId, sessionId, taskCreationSessions, bot);
        await bot.answerCallbackQuery(callbackQuery.id);
        return;
      }

    } catch (error) {
      console.error('Ошибка в обработке callback:', error);
      await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Произошла ошибка' });
    }
  });
}

module.exports = {
  handleCallbacks
};