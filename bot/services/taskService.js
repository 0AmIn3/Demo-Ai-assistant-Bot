const axios = require('axios');
const FormData = require('form-data');
const { loadDB, saveDB } = require('../../database/db');
const { escapeMarkdown } = require('../utils/helpers');
const plankaService = require('./plankaService');
const { createTaskReturnButton } = require('../utils/helpers');
const { OWNER_USERNAME } = require('../../config/constants')
// Функция отображения задач пользователя
async function showUserTasks(userId, chatId, bot) {
  try {
    const db = loadDB();
    const employee = db.employees.find(emp => emp.telegramUserId == userId);

    if (!employee) {
      await bot.sendMessage(chatId, '❌ Вы не зарегистрированы в системе');
      return;
    }

    const accessToken = await plankaService.getPlankaAccessToken();

    // Получаем все данные с доски включая карточки и их участников
    const response = await axios.get(
      `${process.env.PLANKA_BASE_URL}/boards/${process.env.PLANKA_BOARD_ID}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    if (!response.data || !response.data.included) {
      console.error('Неверная структура ответа от Planka:', response.data);
      await bot.sendMessage(chatId, '❌ Ошибка при получении данных из Planka');
      return;
    }

    const cards = response.data.included.cards || [];
    const cardMemberships = response.data.included.cardMemberships || [];
    const lists = response.data.included.lists || [];

    // Находим карточки, где пользователь является участником
    const userCardIds = cardMemberships
      .filter(membership => membership.userId === employee.plankaUserId)
      .map(membership => membership.cardId);

    const userCards = cards.filter(card => userCardIds.includes(card.id));

    console.log('Найдено карточек пользователя:', userCards.length);

    if (userCards.length === 0) {
      await bot.sendMessage(chatId, '📝 У вас нет назначенных задач');
      return;
    }

    // Создаем карту списков
    const listMap = {};
    lists.forEach(list => {
      listMap[list.id] = list.name;
    });
    const isOwner = employee.username === OWNER_USERNAME;

    // Формируем клавиатуру с задачами
    const keyboard = userCards.map(card => ([{
      text: `${card.name} (${listMap[card.listId] || 'Неизвестный статус'})`,
      callback_data: isOwner ? `edit_task_${card.id}` : `view_task_${card.id}`
    }]));

    const roleText = isOwner ? 'редактирования' : 'просмотра';
    await bot.sendMessage(chatId,
      `📋 Ваши задачи (${userCards.length}):\n\nВыберите задачу для ${roleText}:`,
      { reply_markup: { inline_keyboard: keyboard } }
    );

  } catch (error) {
    console.error('Ошибка получения задач пользователя:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при получении списка задач');
  }
}

// Функция поиска задач для владельца
async function searchTasks(query, chatId, bot, username) {
  try {
    const accessToken = await plankaService.getPlankaAccessToken();

    // Получаем все данные с доски включая карточки
    const response = await axios.get(
      `${process.env.PLANKA_BASE_URL}/boards/${process.env.PLANKA_BOARD_ID}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );


    if (!response.data || !response.data.included) {
      console.error('Неверная структура ответа от Planka:', response.data);
      await bot.sendMessage(chatId, '❌ Ошибка при получении данных из Planka');
      return;
    }

    const cards = response.data.included.cards || [];
    const lists = response.data.included.lists || [];

    console.log('Найдено карточек:', cards.length);
    console.log('Найдено списков:', lists.length);

    if (cards.length === 0) {
      await bot.sendMessage(chatId, '📝 На доске нет задач');
      return;
    }

    // Создаем карту списков
    const listMap = {};
    lists.forEach(list => {
      listMap[list.id] = list.name;
    });

    // Фильтруем карточки по поисковому запросу
    const filteredCards = cards.filter(card => {
      const searchText = query.toLowerCase();
      return (
        card.name.toLowerCase().includes(searchText) ||
        (card.description && card.description.toLowerCase().includes(searchText)) ||
        card.id.toString().includes(searchText)
      );
    });

    if (filteredCards.length === 0) {
      await bot.sendMessage(chatId, '🔍 Задачи не найдены');
      return;
    }

    const isOwner = username === OWNER_USERNAME;

    const keyboard = filteredCards.slice(0, 10).map(card => ([{
      text: `${card.name} (${listMap[card.listId] || 'Неизвестный статус'})1`,
      callback_data: isOwner ? `edit_task_${card.id}` : `view_task_${card.id}`
    }]));

    if (filteredCards.length > 10) {
      keyboard.push([{
        text: `... и еще ${filteredCards.length - 10} задач`,
        callback_data: 'search_more'
      }]);
    }

    const actionText = isOwner ? 'редактирования' : 'просмотра';
    await bot.sendMessage(chatId,
      `🔍 Найдено задач: ${filteredCards.length}\n\nВыберите задачу для ${actionText}:`,
      { reply_markup: { inline_keyboard: keyboard } }
    );

  } catch (error) {
    console.error('Ошибка поиска задач:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при поиске задач');
  }
}

// Функция отображения детальной информации о задаче
async function showTaskDetails(cardId, chatId, userId, isOwner, bot) {
  try {
    const card = await plankaService.getCard(cardId);
    if (!card) {
      await bot.sendMessage(chatId, '❌ Задача не найдена');
      return;
    }

    const lists = await plankaService.getPlankaLists();
    const targetList = lists.find(list => list.id === card.listId);
    const listName = targetList.name || 'Неизвестный статус';

    // Получаем лейблы карточки
    let priorityText = '';
    try {
      const cardLabels = await plankaService.getCardLabels(cardId);
      if (cardLabels && cardLabels.length > 0) {
        const boardLabels = await plankaService.getBoardLabels();
        const cardLabelNames = cardLabels.map(cardLabel => {
          const label = boardLabels.find(l => l.id === cardLabel.labelId);
          return label ? label.name : 'Неизвестный лейбл';
        });
        priorityText = `⚡ Приоритет: ${cardLabelNames.join(', ')}\n`;
      }
    } catch (labelError) {
      console.error('Ошибка получения лейблов карточки:', labelError);
    }

    let message =
      `📋 *${escapeMarkdown(card.name)}*\n\n` +
      `📝 Описание: ${escapeMarkdown(card.description || 'Нет описания')}\n` +
      priorityText +  // Добавляем информацию о приоритете
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
      keyboard = lists.filter(list => listName !== list.name).map(list => ([{
        text: `➡️ ${list.name}`,
        callback_data: `move_card_${cardId}_${list.id}`
      }]));

      keyboard.unshift([{
        text: '🔄 Обновить информацию',
        callback_data: `refresh_task_${cardId}`
      }]);

      keyboard.push([{
        text: '❌ Отменить действия',
        callback_data: `close_task_${cardId}`
      }]);
    }

    await bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard }
    });

  } catch (error) {
    console.error('Ошибка получения информации о задаче:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при получении информации о задаче');
  }
}

// Перемещение карточки
async function moveCardTask(cardId, listId, chatId, userId, bot) {
  try {
    await plankaService.moveCard(cardId, listId);

    // Получаем название нового списка
    const lists = await plankaService.getPlankaLists();
    const targetList = lists.find(list => list.id === listId);
    const listName = targetList?.name || 'Неизвестный статус';

    await bot.sendMessage(chatId, `✅ Задача перемещена в статус "${listName}"`);

    // Обновляем отображение задачи
    await showTaskDetails(cardId, chatId, userId, false, bot);

  } catch (error) {
    console.error('Ошибка перемещения карточки:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при перемещении задачи');
  }
}

// Обработка редактирования задачи
async function handleTaskEditing(msg, state, bot) {
  const chatId = msg.chat.id;
  const cardId = state.cardId;
  const promptId = state.promptMessageId;     // id сообщения-подсказки

  try {
    if (state.step === 'edit_name') {
      await plankaService.updateCard(cardId, { name: msg.text });

      if (promptId) {
        await bot.deleteMessage(chatId, promptId).catch(() => { });
      }

      await bot.sendMessage(chatId, '✅ Название задачи успешно обновлено', {
        reply_markup: {
          inline_keyboard: [
            [createTaskReturnButton(cardId)],
          ],
        },
      });

    } else if (state.step === 'edit_description') {
      await plankaService.updateCard(cardId, { description: msg.text });

      if (promptId) {
        await bot.deleteMessage(chatId, promptId).catch(() => { });
      }

      await bot.sendMessage(chatId, '✅ Описание задачи успешно обновлено', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '👁 Посмотреть задачу', callback_data: `edit_task_${cardId}` }],
          ],
        },
      });
    } else if (state.step === 'edit_priority') {
      const priority = msg.text.toLowerCase();

      try {
        // Получаем доступные лейблы
        const boardLabels = await plankaService.getBoardLabels();
        const priorityInfo = plankaService.getPriorityFromLabels(boardLabels, priority);

        if (!priorityInfo) {
          await bot.sendMessage(chatId, '❌ Приоритет не найден. Используйте интерактивную кнопку для выбора.');
          return;
        }

        // Получаем текущие лейблы карточки и удаляем старые приоритеты
        const currentLabels = await plankaService.getCardLabels(cardId);
        const priorityLabels = boardLabels.filter(label =>
          ['высокий', 'средний', 'низкий', 'high', 'medium', 'low', 'срочно', 'urgent', 'critical', 'критический'].some(p =>
            label.name.toLowerCase().includes(p)
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
        await plankaService.addLabelToCard(cardId, priorityInfo.labelId);

        if (promptId) {
          try {
            await bot.deleteMessage(chatId, promptId);
          } catch (error) {
            console.error('Ошибка удаления сообщения-подсказки:', error);
          }
        }

        await bot.sendMessage(chatId, `✅ Приоритет обновлён на "${priorityInfo.labelName}"`, {
          reply_markup: {
            inline_keyboard: [[{ text: '👁 Посмотреть задачу', callback_data: `edit_task_${cardId}` }]]
          }
        });

      } catch (error) {
        console.error('Ошибка установки приоритета:', error);
        await bot.sendMessage(chatId, '❌ Ошибка при установке приоритета', {
          reply_markup: {
            inline_keyboard: [[{ text: '👁 Посмотреть задачу', callback_data: `edit_task_${cardId}` }]]
          }
        });
      }
    }
    else if (state.step === 'edit_duedate') {
      // парсим формат "YYYY-MM-DD HH:MM"
      const parsed = msg.text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/);
      if (!parsed) {
        await bot.sendMessage(chatId, '❌ Неверный формат. Используйте YYYY-MM-DD HH:MM');
        return;
      }
      const iso = new Date(parsed[1] + 'T' + parsed[2] + ':00').toISOString();
      await plankaService.updateCard(cardId, { dueDate: iso });
      if (promptId) await bot.deleteMessage(chatId, promptId).catch(() => { });
      const display = new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
      await bot.sendMessage(chatId, `✅ Срок выполнения изменён на ${display}`, {
        reply_markup: {
          inline_keyboard: [[{ text: '👁 Посмотреть задачу', callback_data: `edit_task_${cardId}` }]]
        }
      });
    }

  } catch (error) {
    console.error('Ошибка при обновлении задачи:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при обновлении задачи', {
      reply_markup: {
        inline_keyboard: [[
          { text: '👁 Посмотреть задачу', callback_data: `edit_task_${cardId}` }
        ]]
      }
    });
  }
}

// Функция отображения управления файлами
async function showFileManagement(cardId, chatId, messageId, bot) {
  try {
    const attachments = await plankaService.getCardAttachments(cardId);

    let message = '📎 Управление файлами\n\n';

    if (attachments.length === 0) {
      message += 'Файлов нет\n\n';
    } else {
      message += 'Прикрепленные файлы:\n';
      attachments.forEach((file, index) => {
        message += `${index + 1}. ${file.name}\n`;
      });
      message += '\n';
    }

    const keyboard = [
      [{ text: '➕ Добавить файлы', callback_data: `add_file_${cardId}` }]
    ];

    // Добавляем кнопки удаления файлов
    if (attachments.length > 0) {
      attachments.forEach(file => {
        keyboard.push([{
          text: `🗑 Удалить "${file.name}"`,
          callback_data: `delete_file_${file.id}`
        }]);
      });
    }

    keyboard.push([
      { text: '🔙 Назад к задаче', callback_data: `back_to_task_${cardId}` },
      { text: '❌ Отменить действия', callback_data: `close_task_${cardId}` }
    ]);

    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: keyboard }
    });

  } catch (error) {
    console.error('Ошибка получения файлов:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при получении списка файлов');
  }
}

// Отображение опций перемещения задачи
async function showMoveTaskOptions(cardId, chatId, messageId, bot) {
  try {
    const lists = await plankaService.getPlankaLists();

    const keyboard = lists.map(list => ([{
      text: `➡️ ${list.name}`,
      callback_data: `owner_move_${cardId}_${list.id}`
    }]));

    keyboard.push([
      { text: '🔙 Назад', callback_data: `back_to_task_${cardId}` },
      { text: '❌ Отменить действия', callback_data: `close_task_${cardId}` }
    ]);

    await bot.editMessageText(
      '🔄 Выберите статус для задачи:',
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard }
      }
    );

  } catch (error) {
    console.error('Ошибка получения списков:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при получении списков');
  }
}

// Функция удаления задачи
async function deleteTask(cardId, chatId, messageId, bot) {
  try {
    await plankaService.deleteCard(cardId);

    await bot.editMessageText(
      '✅ Задача успешно удалена',
      {
        chat_id: chatId,
        message_id: messageId
      }
    );

  } catch (error) {
    console.error('Ошибка удаления задачи:', error);
    await bot.editMessageText(
      '❌ Ошибка при удалении задачи',
      {
        chat_id: chatId,
        message_id: messageId
      }
    );
  }
}

// Функция удаления вложения
async function deleteAttachmentTask(attachmentId, chatId, bot) {
  try {
    await plankaService.deleteAttachment(attachmentId);
    await bot.sendMessage(chatId, '✅ Файл удален');
  } catch (error) {
    console.error('Ошибка удаления файла:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при удалении файла');
  }
}

// Создание задачи в Planka
async function createPlankaTask(session, chatId, messageId, sessionId, taskCreationSessions, bot) {
  try {
    // Создаем карточку
    const cardData = {
      name: session.analysis.title,
      description: `${session.analysis.description}\n`,
      position: 1,
      isDueDateCompleted: false
    };

    // Добавляем срок выполнения если он указан
    if (session.analysis.assigneeInfo?.dueDate) {
      cardData.dueDate = session.analysis.assigneeInfo.dueDate;
    }

    const createdCard = await plankaService.createCard(session.selectedListId, cardData);
    const cardId = createdCard.id;

    // Добавляем приоритет (лейбл) к карточке
    if (session.analysis.priorityInfo && session.analysis.priorityInfo.labelId) {
      try {
        await plankaService.addLabelToCard(cardId, session.analysis.priorityInfo.labelId);
        console.log(`Добавлен лейбл приоритета: ${session.analysis.priorityInfo.labelName}`);
      } catch (labelError) {
        console.error('Ошибка при добавлении лейбла приоритета:', labelError);
        // Продолжаем выполнение, даже если лейбл не добавился
      }
    }

    // Назначаем исполнителя и отправляем уведомление
    if (session.selectedAssigneeId && session.selectedAssigneeId !== 'none') {
      try {
        await plankaService.assignCardMember(cardId, session.selectedAssigneeId);

        // Отправляем уведомление исполнителю
        await notifyAssignee(createdCard, session.selectedAssigneeId, bot);

      } catch (membershipError) {
        console.error('Ошибка при назначении исполнителя:', membershipError.response?.data || membershipError.message);
      }
    }

    // Прикрепляем файлы
    if (session.attachments && session.attachments.length > 0) {
      for (let attachment of session.attachments) {
        try {
          const fileResponse = await axios.get(attachment.url, {
            responseType: 'stream'
          });

          const form = new FormData();
          form.append('file', fileResponse.data, attachment.name);
          form.append('name', attachment.name);

          const accessToken = await plankaService.getPlankaAccessToken();
          await axios.post(
            `${process.env.PLANKA_BASE_URL}/cards/${cardId}/attachments`,
            form,
            {
              headers: {
                ...form.getHeaders(),
                Authorization: `Bearer ${accessToken}`
              }
            }
          );
        } catch (attachmentError) {
          console.error(`Ошибка при прикреплении файла "${attachment.name}":`,
            attachmentError.response?.data || attachmentError.message);
        }
      }
    }

    // Формируем сообщение об успешном создании
    let message = `✅ Задача успешно создана в Planka!\n\n` +
      `📝 Название: ${session.analysis.title}\n`;

    // Показываем приоритет из лейбла, если он был добавлен
    if (session.analysis.priorityInfo) {
      message += `⚡ Приоритет: ${session.analysis.priorityInfo.labelName}\n`;
    } else {
      message += `⚡ Приоритет: ${session.analysis.priority}\n`;
    }

    if (session.analysis.assigneeInfo.dueDate) {
      const dueDate = new Date(session.analysis.assigneeInfo.dueDate);
      const now = new Date();
      const isOverdue = dueDate < now;
      const dateStr = dueDate.toLocaleDateString('ru-RU');
      const timeStr = dueDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

      if (isOverdue) {
        message += `⏰ Срок (просрочен): ${dateStr} ${timeStr}\n`;
      } else {
        message += `📅 Срок выполнения: ${dateStr} ${timeStr}\n`;
      }
    }

    message += `🔗 Ссылка на карточку: https://swifty.uz/cards/${cardId}\n`;

    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: messageId,
      disable_web_page_preview: true
    });

    // Удаляем сессию и сохраняем историю
    delete taskCreationSessions[sessionId];

    const db = loadDB();
    db.taskSessions = db.taskSessions?.filter(s => s.sessionId !== sessionId) || [];
    db.taskHistory = db.taskHistory || [];
    db.taskHistory.push({
      sessionId,
      cardId,
      createdAt: new Date().toISOString(),
      creator: session.username,
      title: session.analysis.title,
      priority: session.analysis.priorityInfo?.labelName || session.analysis.priority,
      category: session.analysis.category
    });
    saveDB(db);

  } catch (error) {
    console.error('Ошибка при создании задачи в Planka:', error.response?.data || error.message);

    let errorMessage = '❌ Ошибка при создании задачи';
    if (error.response?.data?.message) {
      errorMessage += `: ${error.response.data.message}`;
    } else if (error.message) {
      errorMessage += `: ${error.message}`;
    }

    await bot.editMessageText(errorMessage, {
      chat_id: chatId,
      message_id: messageId
    });
  }
}

// Уведомление исполнителя
async function notifyAssignee(cardData, assigneeId, bot) {
  if (!assigneeId) return;

  try {
    const db = loadDB();
    const employee = db.employees.find(emp => emp.plankaUserId == assigneeId);

    if (!employee || !employee.telegramChatId) {
      console.log('Исполнитель не найден в базе или нет Telegram ID');
      return;
    }

    let message =
      `🎯 *Вам назначена новая задача!*\n\n` +
      `📝 *Название:* ${escapeMarkdown(cardData.name)}\n` +
      `📋 *Описание:* ${escapeMarkdown(cardData.description || 'Нет описания')}\n`

    if (cardData.dueDate) {
      const dueDate = new Date(cardData.dueDate);
      const dateStr = dueDate.toLocaleDateString('ru-RU');
      const timeStr = dueDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      message += `📅 *Срок выполнения:* ${dateStr} ${timeStr}\n`;
    }
    message += `🔗 *Ссылка на карточку:* https://swifty.uz/cards/${cardData.id}\n\n` +
      `Используйте команду /my\\_tasks для просмотра всех ваших задач`;

    const isOwner = employee.username === OWNER_USERNAME;
    const taskButtonData = isOwner ? `edit_task_${cardData.id}` : `view_task_${cardData.id}`;
    const taskButtonText = isOwner ? '✏️ Редактировать задачу' : '👁 Посмотреть задачу';


    await bot.sendMessage(employee.telegramChatId, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '📋 Мои задачи', callback_data: 'show_my_tasks' },
          { text: taskButtonText, callback_data: taskButtonData }
        ]]
      }
    });

  } catch (error) {
    console.error('Ошибка отправки уведомления исполнителю:', error);
  }
}

// Обработка файлов для задач
async function handleFileAttachment(msg, type, taskCreationSessions, bot) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Находим активную сессию
  const sessionId = Object.keys(taskCreationSessions).find(id =>
    taskCreationSessions[id].chatId === chatId &&
    taskCreationSessions[id].userId === userId &&
    taskCreationSessions[id].step === 'waiting_files'
  );

  if (!sessionId) return;

  const session = taskCreationSessions[sessionId];

  try {
    let fileId, fileName;

    if (type === 'document') {
      fileId = msg.document.file_id;
      fileName = msg.document.file_name;
    } else if (type === 'photo') {
      // Берем фото наибольшего размера
      const photo = msg.photo[msg.photo.length - 1];
      fileId = photo.file_id;
      fileName = `photo_${Date.now()}.jpg`;
    }

    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    session.attachments = session.attachments || [];
    session.attachments.push({
      name: fileName,
      url: fileUrl,
      size: file.file_size
    });

    await bot.sendMessage(chatId, `✅ Файл "${fileName}" добавлен!`);

  } catch (error) {
    console.error('Ошибка при обработке файла:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при обработке файла');
  }
}

// Обработка файлов для существующих задач
async function handleFileForExistingTask(msg, type, userStates, bot) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (!userStates[userId] || userStates[userId].state !== 'adding_files') {
    return;
  }

  try {
    let fileId, fileName;

    if (type === 'document') {
      fileId = msg.document.file_id;
      fileName = msg.document.file_name;
    } else if (type === 'photo') {
      const photo = msg.photo[msg.photo.length - 1];
      fileId = photo.file_id;
      fileName = `photo_${Date.now()}.jpg`;
    }

    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    userStates[userId].attachments = userStates[userId].attachments || [];
    userStates[userId].attachments.push({
      name: fileName,
      url: fileUrl,
      size: file.file_size
    });

    await bot.sendMessage(chatId,
      `✅ Файл "${fileName}" добавлен в очередь!\n\n` +
      `Файлов в очереди: ${userStates[userId].attachments.length}\n` +
      `Используйте /done когда закончите добавлять файлы`
    );

  } catch (error) {
    console.error('Ошибка при обработке файла для существующей задачи:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при обработке файла');
  }
}

// Завершение добавления файлов
async function handleFilesCompletion(userId, chatId, userStates, bot) {
  if (!userStates[userId] || userStates[userId].state !== 'adding_files') {
    return;
  }

  const state = userStates[userId];
  const cardId = state.cardId;

  if (!state.attachments || state.attachments.length === 0) {
    await bot.sendMessage(chatId, '❌ Файлы не были добавлены', {
      reply_markup: {
        inline_keyboard: [[
          { text: '👁 Посмотреть задачу', callback_data: `edit_task_${cardId}` }
        ]]
      }
    });
    delete userStates[userId];
    return;
  }

  try {
    // Добавляем все файлы к задаче
    for (let attachment of state.attachments) {
      const fileResponse = await axios.get(attachment.url, {
        responseType: 'stream'
      });

      const form = new FormData();
      form.append('file', fileResponse.data, attachment.name);
      form.append('name', attachment.name);

      const accessToken = await plankaService.getPlankaAccessToken();
      await axios.post(
        `${process.env.PLANKA_BASE_URL}/cards/${cardId}/attachments`,
        form,
        {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${accessToken}`
          }
        }
      );
    }

    await bot.sendMessage(chatId, `✅ Успешно добавлено файлов: ${state.attachments.length}`, {
      reply_markup: {
        inline_keyboard: [[
          { text: '👁 Посмотреть задачу', callback_data: `edit_task_${cardId}` }
        ]]
      }
    });

    delete userStates[userId];

  } catch (error) {
    console.error('Ошибка добавления файлов:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при добавлении файлов', {
      reply_markup: {
        inline_keyboard: [[
          { text: '👁 Посмотреть задачу', callback_data: `edit_task_${cardId}` }
        ]]
      }
    });
    delete userStates[userId];
  }
}

module.exports = {
  showUserTasks,
  searchTasks,
  showTaskDetails,
  moveCardTask,
  handleTaskEditing,
  showFileManagement,
  showMoveTaskOptions,
  deleteTask,
  deleteAttachmentTask,
  createPlankaTask,
  notifyAssignee,
  handleFileAttachment,
  handleFileForExistingTask,
  handleFilesCompletion
};