const fs = require('fs');
const axios = require('axios');
const os = require('os');
const { loadDB, saveDB } = require('../../database/db');
const { getOwnerUsername, OWNER_USERNAME } = require('../../config/constants');
const { hasActiveCreationSession, escapeMarkdown, generatePassword } = require('../utils/helpers');
const { validateEmail } = require('../utils/validation');
const { createListSelectionKeyboard } = require('../utils/keyboards');
const { analyzeMessageWithGemini } = require('../services/geminiService');
const { findAssigneeInDatabase, createAssigneeFoundMessage, createAssigneeNotFoundMessage } = require('../services/assigneeService');
const plankaService = require('../services/plankaService');
const taskService = require('../services/taskService');
const { employeeData } = require('./commands');
const { getChatInviteLink, fetchMainInviteLink } = require('../utils/invate');




// Основной обработчик сообщений
// В функции handleMessages убираем обработку групповых сообщений для создания задач
function handleMessages(bot, userStates, taskCreationSessions, openai) {
  bot.on('message', async (msg) => {
    // Пропускаем команды и системные сообщения
    if (!msg.text || msg.text.startsWith('/') || !msg.from.username) {
      return;
    }

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;

    // Проверяем, если это личный чат
    if (msg.chat.type === 'private') {
      // Проверяем состояния пользователя для личного чата
      if (userStates[userId]) {
        const state = userStates[userId];

        if (state.state === 'searching_tasks' && state.step === 'waiting_query') {
          await taskService.searchTasks(msg.text, chatId, bot, username);
          delete userStates[userId];
          return;
        }

        if (state.state === 'editing_task') {
          await taskService.handleTaskEditing(msg, state, bot);
          delete userStates[userId];
          return;
        }

        // НОВАЯ ЛОГИКА: Обработка создания задач в личном чате
        if (state.state === 'creating_task' && state.step === 'waiting_message') {
          if (chatId !== (getOwnerUsername(chatId) || OWNER_USERNAME)) {
            await bot.sendMessage(chatId, '❌ Создание задач доступно только владельцу');
            delete userStates[userId];
            return;
          }

          await handleTaskCreationInPrivateChat(msg, state, bot, taskCreationSessions);
          delete userStates[userId];
          return;
        }
      }

      // Если нет активных состояний, обрабатываем как регистрацию
      await handlePrivateMessage(msg, bot);
      return;
    }

    // Убираем всю логику создания задач из групповых чатов
    // Групповые чаты теперь используются только для отображения информации
  });
}
async function handleTaskCreationInPrivateChat(msg, state, bot, taskCreationSessions) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;

  // Анализируем сообщение с помощью Gemini (без привязки к конкретной группе)
  const analysis = await analyzeMessageWithGemini(msg.text, username);
  if (!analysis) {
    await bot.sendMessage(chatId, '❌ Не удалось обработать сообщение для создания задачи.');
    return;
  }

  // Создаем сессию для создания задачи
  const sessionId = `${chatId}_${userId}_${Date.now()}`;

  // Пытаемся найти исполнителя в базе данных (из всех сотрудников)
  let autoAssignedEmployee = null;
  let assigneeNotFoundMessage = null;

  if (analysis.assigneeInfo && analysis.assigneeInfo.mentioned) {
    autoAssignedEmployee = findAssigneeInDatabase(analysis.assigneeInfo);

    if (!autoAssignedEmployee) {
      assigneeNotFoundMessage = createAssigneeNotFoundMessage(analysis.assigneeInfo);
    }
  }

  taskCreationSessions[sessionId] = {
    sessionId,
    chatId,
    userId,
    username,
    originalMessage: msg.text,
    analysis,
    step: 'select_list',
    createdAt: new Date(),
    autoAssignedEmployee,
    assigneeNotFoundMessage
  };

  // Получаем списки из Planka
  const lists = await plankaService.getPlankaLists();
  if (lists.length === 0) {
    await bot.sendMessage(chatId, '❌ Не удалось получить списки из Planka.');
    return;
  }

  // Отправляем сообщение с выбором списка
  await sendTaskCreationMessage(analysis, lists, chatId, bot, autoAssignedEmployee, assigneeNotFoundMessage);

  // Сохраняем сессию в базу данных
  const db = loadDB();
  db.taskSessions = db.taskSessions || [];
  db.taskSessions.push({
    sessionId,
    ...taskCreationSessions[sessionId]
  });
  saveDB(db);
}
// НОВАЯ ФУНКЦИЯ: Показ выбора группы для создания задачи
async function showGroupSelection(groups, chatId, bot, sessionId, analysis, taskCreationSessions) {
  const keyboard = groups.map(group => ([{
    text: group.groupTitle || `Группа ${group.telegramGroupId}`,
    callback_data: `select_group_${sessionId}_${group.telegramGroupId}`
  }]));

  keyboard.push([{
    text: '❌ Отмена',
    callback_data: 'cancel_task'
  }]);

  await bot.sendMessage(chatId,
    `🎯 Создание задачи\n\n` +
    `📝 Задача: ${analysis.title}\n` +
    `📋 Описание: ${analysis.description}\n\n` +
    `Выберите группу для создания задачи:`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }
  );
}

// НОВАЯ ФУНКЦИЯ: Отправка сообщения создания задачи
async function sendTaskCreationMessage(analysis, lists, chatId, bot, autoAssignedEmployee, assigneeNotFoundMessage) {
  const escapedTitle = escapeMarkdown(analysis.title);
  const escapedDescription = escapeMarkdown(analysis.description);
  const escapedPriority = escapeMarkdown(analysis.priority);

  let messageText = `🎯 Создание задачи:\n\n` +
    `📝 Название: *${escapedTitle}*\n` +
    `📋 Описание: ${escapedDescription}\n` +
    `⚡ Приоритет: ${escapedPriority}\n`;

  // Добавляем срок выполнения если он указан
  if (analysis.assigneeInfo?.dueDate) {
    const dueDate = new Date(analysis.assigneeInfo.dueDate);
    const dateStr = dueDate.toLocaleDateString('ru-RU');
    const timeStr = dueDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    messageText += `📅 Срок выполнения: ${dateStr} ${timeStr}\n`;
  }

  // Добавляем информацию об исполнителе
  if (autoAssignedEmployee) {
    messageText += `\n${createAssigneeFoundMessage(autoAssignedEmployee, analysis.assigneeInfo)}\n`;
  } else if (analysis.assigneeInfo && analysis.assigneeInfo.mentioned) {
    messageText += `\n❓ Исполнитель упомянут, но не найден автоматически\n`;
  }

  messageText += `\nВыберите статус для задачи:`;

  await bot.sendMessage(chatId, messageText, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: createListSelectionKeyboard(lists)
  });
}
// Обработка голосовых сообщений
function handleVoiceMessages(bot, userStates, taskCreationSessions, openai) {
  bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;

    // Проверяем ключевые слова для создания задач из голосовых сообщений
    if (userStates[userId] && userStates[userId].state === 'creating_task' && userStates[userId].step === 'waiting_message') {
      await handleVoiceTaskCreation(msg, userId, chatId, username, userStates, taskCreationSessions, openai, bot);
      return;
    }

    // Обработка голосовых сообщений с ключевыми словами (без команды)
    if (chatId === (getOwnerUsername(chatId) || OWNER_USERNAME)) {
      await handleVoiceTaskCreation(msg, userId, chatId, username, userStates, taskCreationSessions, openai, bot);
    }
  });
}

// Вынесенная функция обработки голосовых сообщений для создания задач
async function handleVoiceTaskCreation(msg, userId, chatId, username, userStates, taskCreationSessions, openai, bot) {
  try {
    const plankaService = require('../services/plankaService');

    // Получаем ID файла голосового сообщения
    const fileId = msg.voice.file_id;
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    // Скачиваем файл
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const audioBuffer = response.data;

    // Сохраняем аудио во временный файл
    const tempFilePath = `${os.tmpdir()}/voice_${Date.now()}.ogg`;
    fs.writeFileSync(tempFilePath, audioBuffer);
    console.log('Старт транскрипции через Gemini...');

    // Транскрибируем аудио с помощью Gemini
    const transcribedText = await transcribeWithGemini(tempFilePath);

    if (!transcribedText) {
      fs.unlinkSync(tempFilePath);
      await bot.sendMessage(chatId, '❌ Не удалось распознать голосовое сообщение');
      return;
    }

    console.log('Конец транскрипции через Gemini...');
    console.log('Распознанный текст:', transcribedText);

    // Удаляем временный файл
    fs.unlinkSync(tempFilePath);

    // Проверяем, работает ли это в личном чате
    if (msg.chat.type !== 'private') {
      console.log('Голосовое сообщение в группе игнорируется (создание задач только в личке)');
      return;
    }

    // Проверяем ключевые слова в транскрибированном тексте
    const taskKeywords = ['помощник', 'ассистент', 'ердамчи', 'pomoshnik', 'asistant', 'yordamchi', 'ёрдамчи', 'asistent'];
    const MessageText = transcribedText.toLowerCase().trim();
    const startsWithKeyword = taskKeywords.some(keyword => MessageText.startsWith(keyword));

    // Если нет ключевого слова и нет активного состояния создания задачи, игнорируем
    if (!startsWithKeyword && (!userStates[userId] || userStates[userId].state !== 'creating_task')) {
      return;
    }

    // Проверяем, что пользователь - владелец
    if (chatId !== (getOwnerUsername(chatId) || OWNER_USERNAME)) {
      await bot.sendMessage(chatId, '❌ Создание задач доступно только владельцу');
      return;
    }

    let cleanedText = transcribedText;
    if (startsWithKeyword) {
      // Убираем ключевое слово из текста для анализа
      cleanedText = transcribedText.replace(/^(помощник|ассистент|ердамчи|pomoshnik|asistant|yordamchi|ёрдамчи|asistent)\s*/i, '').trim();

      if (!cleanedText) {
        await bot.sendMessage(chatId, '❌ Пожалуйста, укажите описание задачи после ключевого слова.');
        return;
      }
    }

    // Анализируем транскрибированный текст через Gemini для создания задачи (БЕЗ привязки к группе)
    const analysis = await require('../services/geminiService').analyzeMessageWithGemini(cleanedText, username);
    if (!analysis) {
      await bot.sendMessage(chatId, '❌ Не удалось обработать голосовое сообщение для создания задачи.');
      return;
    }

    // Создаем сессию для создания задачи
    const sessionId = `${chatId}_${userId}_${Date.now()}`;

    // Пытаемся найти исполнителя в базе данных (из всех сотрудников)
    let autoAssignedEmployee = null;
    let assigneeNotFoundMessage = null;

    if (analysis.assigneeInfo && analysis.assigneeInfo.mentioned) {
      autoAssignedEmployee = require('../services/assigneeService').findAssigneeInDatabase(analysis.assigneeInfo);

      if (!autoAssignedEmployee) {
        assigneeNotFoundMessage = require('../services/assigneeService').createAssigneeNotFoundMessage(analysis.assigneeInfo);
      }
    }

    taskCreationSessions[sessionId] = {
      sessionId,
      chatId,
      userId,
      username,
      originalMessage: cleanedText,
      analysis,
      step: 'select_list',
      createdAt: new Date(),
      autoAssignedEmployee,
      assigneeNotFoundMessage
    };

    // Получаем списки из Planka
    const lists = await plankaService.getPlankaLists();
    if (lists.length === 0) {
      await bot.sendMessage(chatId, '❌ Не удалось получить списки из Planka.');
      return;
    }

    // Отправляем сообщение с выбором списка
    const { escapeMarkdown } = require('../utils/helpers');
    const { createListSelectionKeyboard } = require('../utils/keyboards');

    const escapedTitle = escapeMarkdown(analysis.title);
    const escapedDescription = escapeMarkdown(analysis.description);
    const escapedPriority = escapeMarkdown(analysis.priority);

    let messageText = `🎯 Создание задачи на основе голосового сообщения:\n\n` +
      `📝 Название: *${escapedTitle}*\n` +
      `📋 Описание: ${escapedDescription}\n` +
      `⚡ Приоритет: ${escapedPriority}\n`;

    // Добавляем срок выполнения если он указан
    if (analysis.assigneeInfo?.dueDate) {
      const dueDate = new Date(analysis.assigneeInfo.dueDate);
      const dateStr = dueDate.toLocaleDateString('ru-RU');
      const timeStr = dueDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      messageText += `📅 Срок выполнения: ${dateStr} ${timeStr}\n`;
    }

    // Добавляем информацию об исполнителе
    if (autoAssignedEmployee) {
      messageText += `\n${require('../services/assigneeService').createAssigneeFoundMessage(autoAssignedEmployee, analysis.assigneeInfo)}\n`;
    } else if (analysis.assigneeInfo && analysis.assigneeInfo.mentioned) {
      messageText += `\n❓ Исполнитель упомянут, но не найден автоматически\n`;
    }

    messageText += `\nВыберите статус для задачи:`;

    await bot.sendMessage(chatId, messageText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: createListSelectionKeyboard(lists)
    });

    // Сохраняем сессию в базу данных
    const db = require('../../database/db').loadDB();
    db.taskSessions = db.taskSessions || [];
    db.taskSessions.push({
      sessionId,
      ...taskCreationSessions[sessionId]
    });
    require('../../database/db').saveDB(db);

    // Удаляем состояние пользователя после обработки
    delete userStates[userId];

  } catch (error) {
    console.error('Ошибка обработки голосового сообщения:', error);
    await bot.sendMessage(chatId, '❌ Ошибка при обработке голосового сообщения');
  }
}
async function transcribeWithGemini(audioFilePath) {
  try {
    // Читаем аудио файл и конвертируем в base64
    const audioBuffer = fs.readFileSync(audioFilePath);
    const base64Audio = audioBuffer.toString('base64');

    // Определяем MIME тип для .ogg файлов (Telegram voice format)
    const mimeType = 'audio/ogg';

    const prompt = `
Пожалуйста, транскрибируй это аудио сообщение в текст. 
Сообщение может быть на русском или узбекском языке.
Верни только транскрибированный текст без дополнительных комментариев.

Особенности распознавания:
- Учитывай особенности произношения в узбекском и русском языках
`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              text: prompt
            },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64Audio
              }
            }
          ]
        }],
        generationConfig: {
          temperature: 0.1, // Низкая температура для точности
          maxOutputTokens: 1000
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Ошибка Gemini API для транскрипции:', {
        status: response.status,
        statusText: response.statusText,
        error: errorData
      });
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Проверяем структуру ответа
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
      console.error('Неожиданная структура ответа Gemini:', JSON.stringify(data, null, 2));
      return null;
    }

    const candidate = data.candidates[0];

    // Проверяем, заблокирован ли контент
    if (candidate.finishReason === 'SAFETY') {
      console.error('Контент заблокирован по соображениям безопасности');
      return null;
    }

    if (!candidate.content.parts || !candidate.content.parts[0]) {
      console.error('Отсутствует текст в ответе Gemini');
      return null;
    }

    const transcribedText = candidate.content.parts[0].text;

    // Очищаем текст от возможных артефактов и лишних символов
    return transcribedText.trim();

  } catch (error) {
    console.error('Ошибка транскрипции через Gemini:', {
      message: error.message,
      stack: error.stack
    });
    return null;
  }
}

// Обработка документов
function handleDocuments(bot, userStates, taskCreationSessions) {
  bot.on('document', async (msg) => {
    const userId = msg.from.id;

    if (userStates[userId] && userStates[userId].state === 'adding_files') {
      await taskService.handleFileForExistingTask(msg, 'document', userStates, bot);
      return;
    }

    // Существующий обработчик для создания новых задач
    await taskService.handleFileAttachment(msg, 'document', taskCreationSessions, bot);
  });
}

// Обработка фотографий
function handlePhotos(bot, userStates, taskCreationSessions) {
  bot.on('photo', async (msg) => {
    const userId = msg.from.id;

    if (userStates[userId] && userStates[userId].state === 'adding_files') {
      await taskService.handleFileForExistingTask(msg, 'photo', userStates, bot);
      return;
    }

    // Существующий обработчик для создания новых задач
    await taskService.handleFileAttachment(msg, 'photo', taskCreationSessions, bot);
  });
}

// Обработка личных сообщений для регистрации
async function handlePrivateMessage(msg, bot) {
  const chatId = msg.chat.id;
  const data = employeeData[chatId];
  const username = msg.from.username;

  if (!data || !msg.text) {
    return;
  }

  switch (data.step) {
    case 'email':
      const email = msg.text.trim().toLowerCase();
      if (!validateEmail(email)) {
        bot.sendMessage(chatId, 'Пожалуйста, введите корректный email адрес:');
        return;
      }

      await bot.sendMessage(chatId, '⏳ Проверяю ваш email в системе...');

      try {
        // Проверяем, есть ли пользователь с таким email в Planka
        const existingUser = await plankaService.findUserByEmail(email);

        if (existingUser) {
          // Пользователь существует в Planka, запрашиваем пароль
          data.email = email;
          data.plankaUserId = existingUser.id;
          data.step = 'password';
          data.isExistingUser = true;

          await bot.sendMessage(chatId,
            `✅ Ваш email найден в системе!\n\n` +
            `Введите ваш пароль от Planka для подтверждения:`
          );
        } else {
          // Пользователь не существует, продолжаем регистрацию
          data.email = email;
          data.step = 'name';
          data.isExistingUser = false;

          await bot.sendMessage(chatId,
            `📝 Email не найден в системе. Создаем новый аккаунт.\n\n` +
            `Введите ваше полное имя:`
          );
        }
      } catch (error) {
        console.error('Ошибка при проверке email в Planka:', error);
        await bot.sendMessage(chatId,
          '❌ Ошибка при проверке email. Попробуйте еще раз или обратитесь к администратору.'
        );
      }
      break;

    case 'password':
      if (!data.isExistingUser) {
        await bot.sendMessage(chatId, '❌ Ошибка в процессе регистрации. Начните сначала.');
        delete employeeData[chatId];
        return;
      }

      const password = msg.text.trim();
      if (password.length < 1) {
        await bot.sendMessage(chatId, 'Пожалуйста, введите пароль:');
        return;
      }

      await bot.sendMessage(chatId, '⏳ Проверяю пароль...');

      try {
        // Проверяем пароль в Planka
        const authResult = await plankaService.verifyUserPassword(data.email, password);

        if (authResult.success) {
          // Пароль правильный, завершаем регистрацию
          const userData = authResult.user || { email: data.email, id: data.plankaUserId };
          await completeExistingUserRegistration(data, userData, chatId, bot, username);
          delete employeeData[chatId];
        } else {
          await bot.sendMessage(chatId,
            `❌ ${authResult.error || 'Неверный пароль'}\n\n` +
            `Попробуйте еще раз или обратитесь к администратору для сброса пароля.`
          );
        }
      } catch (error) {
        console.error('Ошибка при проверке пароля:', error);
        await bot.sendMessage(chatId,
          '❌ Ошибка при проверке пароля. Попробуйте еще раз или обратитесь к администратору.'
        );
      }
      break;

    case 'name':
      if (msg.text.trim().length < 2) {
        bot.sendMessage(chatId, 'Пожалуйста, введите корректное имя (минимум 2 символа):');
        return;
      }
      data.name = msg.text.trim();
      data.step = 'position';
      bot.sendMessage(chatId, 'Введите вашу должность:');
      break;

    case 'position':
      if (msg.text.trim().length < 2) {
        bot.sendMessage(chatId, 'Пожалуйста, введите корректную должность:');
        return;
      }
      data.position = msg.text.trim();
      await registerNewEmployee(data, chatId, bot);
      delete employeeData[chatId];
      break;
  }
}
async function registerNewEmployee(data, chatId, bot) {
  try {
    const db = loadDB();
    const owner = db.owners.find((o) => o.id === data.ownerId);

    if (!owner) {
      bot.sendMessage(chatId, 'Ошибка: владелец не найден. Обратитесь за новой ссылкой.');
      return;
    }

    // Проверяем существующего сотрудника
    const existingEmployee = db.employees.find(emp =>
      emp.email === data.email || emp.userId === data.userId
    );

    if (existingEmployee) {
      bot.sendMessage(chatId,
        `Вы уже зарегистрированы в системе.\n\n` +
        `Имя: ${existingEmployee.name}\n` +
        `Должность: ${existingEmployee.position}\n\n` +
        `Ссылка на группу: ${owner.inviteLink}`
      );
      return;
    }

    await bot.sendMessage(chatId, '⏳ Создаю новый аккаунт в системе...');

    const tempPassword = generatePassword();

    // Создаем пользователя в Planka
    const userData = {
      email: data.email,
      password: tempPassword,
      name: data.name,
      username: data.email.split('@')[0].substring(0, 11) + '_' + Date.now().toString().slice(-4),
    };

    console.log('Создание пользователя в Planka:', { ...userData, password: '***' });

    const plankaUser = await plankaService.createPlankaUser(userData);
    const plankaUserId = plankaUser.id;
    console.log('Пользователь создан с ID:', plankaUserId);

    // Добавляем пользователя к доске
    if (process.env.PLANKA_BOARD_ID) {
      try {
        await plankaService.addUserToBoard(plankaUserId);
        console.log('Пользователь успешно добавлен к доске');
      } catch (boardError) {
        console.error('Ошибка при добавлении пользователя к доске:', boardError.response?.data || boardError.message);
        await bot.sendMessage(chatId, '⚠️ Вас зарегистрировали, но не удалось добавить к доске. Обратитесь к администратору.');
      }
    }

    // Сохраняем данные сотрудника
    const employeeRecord = {
      ...data,
      plankaUserId: String(plankaUserId),
      telegramUserId: String(data.userId),
      telegramChatId: String(chatId),
      registrationDate: new Date().toISOString(),
      groupId: String(owner.telegramGroupId),
      groupTitle: owner.groupTitle,
      plankaUsername: userData.username
    };

    db.employees.push(employeeRecord);
    saveDB(db);

    // Отправляем данные для входа
    await bot.sendMessage(chatId,
      `✅ Регистрация завершена!\n\n` +
      `📋 Данные для входа в Planka:\n` +
      `• Email: ${data.email}\n` +
      `• Логин: ${userData.username.replace(/_/g, '\\_')}\n` +
      `• Временный пароль: \`${tempPassword}\`\n\n` +
      `⚠️ Обязательно смените пароль при первом входе!\n` +
      `🔗 Адрес Planka: https://swifty.uz/`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );

    const inviteLink = await fetchMainInviteLink(bot, owner.telegramGroupId);

    // Отправляем ссылку на группу
    await bot.sendMessage(
      chatId,
      `👥 Присоединяйтесь к рабочей группе "${owner.groupTitle}":\n\n` +
      `${inviteLink}\n\n` +
      `Нажмите на ссылку выше, чтобы вступить в группу.`
    );

    console.log('Регистрация нового сотрудника завершена:', data.email);

  } catch (error) {
    console.error('Ошибка при регистрации нового сотрудника:', error.response?.data || error.message);

    let errorMessage = '❌ Произошла ошибка при регистрации.';
    if (error.response?.data?.message) {
      errorMessage += ` ${error.response.data.message}`;
    }
    errorMessage += ' Попробуйте позже или обратитесь к администратору.';

    bot.sendMessage(chatId, errorMessage);
  }
}
// Завершение регистрации для существующего пользователя
async function completeExistingUserRegistration(data, userData, chatId, bot, username) {
  try {
    const db = loadDB();
    const owner = db.owners.find((o) => o.id === data.ownerId);

    if (!owner) {
      bot.sendMessage(chatId, 'Ошибка: владелец не найден. Обратитесь за новой ссылкой.');
      return;
    }

    // Проверяем, не зарегистрирован ли уже этот пользователь в нашей системе
    const existingEmployee = db.employees.find(emp =>
      emp.email === data.email || emp.userId === data.userId
    );

    const inviteLink = await fetchMainInviteLink(bot, owner.telegramGroupId);
    if (existingEmployee) {
      bot.sendMessage(chatId,
        `Вы уже зарегистрированы в системе.\n\n` +
        `Имя: ${existingEmployee.name}\n` +
        `Должность: ${existingEmployee.position}\n\n` +
        `Ссылка на группу: ${inviteLink}`
      );
      return;
    }

    // Добавляем пользователя к доске в Planka (если еще не добавлен)
    if (process.env.PLANKA_BOARD_ID) {
      try {
        await plankaService.addUserToBoard(data.plankaUserId);
        console.log('Пользователь успешно добавлен к доске');
      } catch (boardError) {
        console.error('Ошибка при добавлении пользователя к доске:', boardError.response?.data || boardError.message);
        // Продолжаем регистрацию, даже если не удалось добавить к доске
      }
    }

    // Сохраняем данные сотрудника в нашей базе
    const employeeRecord = {
      ...data,
      plankaUserId: String(data.plankaUserId),
      telegramUserId: String(data.userId),
      telegramChatId: String(chatId),
      registrationDate: new Date().toISOString(),
      groupId: String(owner.telegramGroupId),
      groupTitle: owner.groupTitle,
      name: data.firstName || 'Не указано',
      username: username, 
    };

    db.employees.push(employeeRecord);
    saveDB(db);

    // Отправляем подтверждение
    await bot.sendMessage(chatId,
      `✅ Успешно вошли в систему!\n\n` +
      `📋 Ваши данные:\n` +
      `• Email: ${data.email}\n` +
      `• Имя: ${data.firstName || 'Не указано'}\n` +
      `Теперь вы можете получать задачи и уведомления.`
    );


    // Отправляем ссылку на группу
    await bot.sendMessage(chatId,
      `👥 Присоединяйтесь к рабочей группе "${owner.groupTitle}":\n\n` +
      `${inviteLink}\n\n` +
      `Нажмите на ссылку выше, чтобы вступить в группу.`
    );

    console.log('Регистрация существующего пользователя завершена:', data.email);

  } catch (error) {
    console.error('Ошибка при регистрации существующего пользователя:', error);
    bot.sendMessage(chatId, '❌ Произошла ошибка при регистрации. Обратитесь к администратору.');
  }
}
// Обработка создания задачи из команды
async function handleTaskCreationFromCommand(msg, state, bot, taskCreationSessions) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;

  const db = loadDB();
  const owner = db.owners.find(o => o.telegramGroupId == chatId);
  if (!owner) {
    await bot.sendMessage(chatId, '❌ Группа не зарегистрирована');
    return;
  }

  // Анализируем сообщение с помощью Gemini
  const analysis = await analyzeMessageWithGemini(msg.text, username, chatId);
  if (!analysis) {
    await bot.sendMessage(chatId, '❌ Не удалось обработать сообщение для создания задачи.');
    return;
  }

  // Создаем сессию для создания задачи
  const sessionId = `${chatId}_${userId}_${Date.now()}`;

  // Пытаемся найти исполнителя в базе данных
  let autoAssignedEmployee = null;
  let assigneeNotFoundMessage = null;

  if (analysis.assigneeInfo && analysis.assigneeInfo.mentioned) {
    autoAssignedEmployee = findAssigneeInDatabase(analysis.assigneeInfo, chatId);

    if (!autoAssignedEmployee) {
      assigneeNotFoundMessage = createAssigneeNotFoundMessage(analysis.assigneeInfo);
    }
  }

  taskCreationSessions[sessionId] = {
    sessionId,
    chatId,
    userId,
    username,
    originalMessage: msg.text,
    analysis,
    step: 'select_list',
    createdAt: new Date(),
    autoAssignedEmployee,
    assigneeNotFoundMessage
  };

  // Получаем списки из Planka
  const lists = await plankaService.getPlankaLists();
  if (lists.length === 0) {
    await bot.sendMessage(chatId, '❌ Не удалось получить списки из Planka.');
    return;
  }

  // Отправляем сообщение с выбором списка
  const escapedTitle = escapeMarkdown(analysis.title);
  const escapedDescription = escapeMarkdown(analysis.description);
  const escapedPriority = escapeMarkdown(analysis.priority);

  let messageText = `🎯 Создание задачи на основе сообщения:\n\n` +
    `📝 Предлагаемое название: *${escapedTitle}*\n` +
    `📋 Описание: ${escapedDescription}\n` +
    `⚡ Приоритет: ${escapedPriority}\n`;

  // Добавляем срок выполнения если он указан
  if (analysis.assigneeInfo?.dueDate) {
    const dueDate = new Date(analysis.assigneeInfo.dueDate);
    const dateStr = dueDate.toLocaleDateString('ru-RU');
    const timeStr = dueDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    messageText += `📅 Срок выполнения: ${dateStr} ${timeStr}\n`;
  }
  // Добавляем информацию об исполнителе
  if (autoAssignedEmployee) {
    messageText += `\n${createAssigneeFoundMessage(autoAssignedEmployee, analysis.assigneeInfo)}\n`;
  } else if (analysis.assigneeInfo && analysis.assigneeInfo.mentioned) {
    messageText += `\n❓ Исполнитель упомянут, но не найден автоматически\n`;
  }

  messageText += `\nВыберите статус для задачи:`;

  try {
    await bot.sendMessage(chatId, messageText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: createListSelectionKeyboard(lists)
    });
  } catch (error) {
    console.error('Ошибка при отправке сообщения:', error);
    await bot.sendMessage(chatId, '❌ Произошла ошибка при создании задачи');
  }

  // Сохраняем сессию в базу данных
  db.taskSessions = db.taskSessions || [];
  db.taskSessions.push({
    sessionId,
    ...taskCreationSessions[sessionId]
  });
  saveDB(db);
}

// Регистрация сотрудника в Planka и отправка ссылки на группу
async function registerEmployee(data, chatId, bot) {
  try {
    const db = loadDB();
    const owner = db.owners.find((o) => o.id === data.ownerId);

    if (!owner) {
      bot.sendMessage(chatId, 'Ошибка: владелец не найден. Обратитесь за новой ссылкой.');
      return;
    }

    // Проверяем существующего сотрудника
    const existingEmployee = db.employees.find(emp =>
      emp.email === data.email || emp.userId === data.userId
    );

    if (existingEmployee) {
      bot.sendMessage(chatId,
        `Вы уже зарегистрированы в системе.\n\n` +
        `Имя: ${existingEmployee.name}\n` +
        `Должность: ${existingEmployee.position}\n\n` +
        `Ссылка на группу: ${owner.inviteLink}`
      );
      return;
    }

    await bot.sendMessage(chatId, '⏳ Регистрация в процессе...');

    const tempPassword = generatePassword();

    // Создаем пользователя в Planka
    const userData = {
      email: data.email,
      password: tempPassword,
      name: data.name,
      username: data.email.split('@')[0].substring(0, 11) + '_' + Date.now().toString().slice(-4),
    };

    console.log('Создание пользователя в Planka:', { ...userData, password: '***' });

    const plankaUser = await plankaService.createPlankaUser(userData);
    const plankaUserId = plankaUser.id;
    console.log('Пользователь создан с ID:', plankaUserId);

    // Добавляем пользователя к доске
    if (process.env.PLANKA_BOARD_ID) {
      try {
        await plankaService.addUserToBoard(plankaUserId);
        console.log('Пользователь успешно добавлен к доске');
      } catch (boardError) {
        console.error('Ошибка при добавлении пользователя к доске:', boardError.response?.data || boardError.message);
        await bot.sendMessage(chatId, '⚠️ Вас зарегистрировали, но не удалось добавить к доске. Обратитесь к администратору.');
      }
    }

    // Сохраняем данные сотрудника
    const employeeRecord = {
      ...data,
      plankaUserId: String(plankaUserId),
      telegramUserId: String(data.userId),
      telegramChatId: String(chatId),
      registrationDate: new Date().toISOString(),
      groupId: String(owner.telegramGroupId),
      groupTitle: owner.groupTitle,
      plankaUsername: userData.username
    };

    db.employees.push(employeeRecord);
    saveDB(db);

    // Отправляем данные для входа
    await bot.sendMessage(chatId,
      `✅ Регистрация завершена!\n\n` +
      `📋 Данные для входа в Planka:\n` +
      `• Email: ${data.email}\n` +
      `• Логин: ${userData.username.replace(/_/g, '\\_')}\n` +
      `• Временный пароль: \`${tempPassword}\`\n\n` +
      `⚠️ Обязательно смените пароль при первом входе!\n` +
      `🔗 Адрес Planka: https://swifty.uz/`,
      { parse_mode: 'Markdown', disable_web_page_preview: true, }
    );

    const inviteLink = await fetchMainInviteLink(bot, owner.telegramGroupId);

    await bot.sendMessage(
      chatId,
      `👥 Присоединяйтесь к рабочей группе "${owner.groupTitle}":\n\n` +
      `${inviteLink}\n\n` +
      `Нажмите на ссылку выше, чтобы вступить в группу.`
    );

    console.log('Регистрация сотрудника завершена:', data.email);

  } catch (error) {
    console.error('Ошибка при регистрации сотрудника:', error.response?.data || error.message);

    let errorMessage = '❌ Произошла ошибка при регистрации.';
    if (error.response?.data?.message) {
      errorMessage += ` ${error.response.data.message}`;
    }
    errorMessage += ' Попробуйте позже или обратитесь к администратору.';

    bot.sendMessage(chatId, errorMessage);
  }
}

module.exports = {
  handleMessages,
  handleVoiceMessages,
  handleDocuments,
  handlePhotos,
  handlePrivateMessage,
  handleTaskCreationFromCommand,
  registerEmployee,
  registerNewEmployee,
  completeExistingUserRegistration
};