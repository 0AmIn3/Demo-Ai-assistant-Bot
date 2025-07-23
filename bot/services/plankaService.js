const axios = require('axios');

// Функция получения токена Planka
async function getPlankaAccessToken() {
  try {
    const response = await axios.post(
      `${process.env.PLANKA_BASE_URL}/access-tokens`,
      {
        emailOrUsername: process.env.PLANKA_ADMIN_USERNAME,
        password: process.env.PLANKA_ADMIN_PASSWORD
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000 // 10 секунд таймаут
      }
    );

    if (!response.data || !response.data.item) {
      throw new Error('Неверный ответ при получении токена');
    }

    return response.data.item;
  } catch (error) {
    console.error('Ошибка при получении токена Planka:', error.response?.data || error.message);
    throw new Error(`Не удалось получить токен доступа: ${error.message}`);
  }
}

// Функция для получения списков и карточек из Planka
async function getPlankaLists() {
  try {
    const accessToken = await getPlankaAccessToken();

    const response = await axios.get(
      `${process.env.PLANKA_BASE_URL}/boards/${process.env.PLANKA_BOARD_ID}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        timeout: 10000
      }
    );

    if (!response.data || !response.data.included) {
      console.error('Неверная структура ответа от Planka:', response.data);
      return [];
    }

    const lists = response.data.included.lists || [];
    console.log('Получено списков из Planka:', lists.length);

    return lists.filter(list => list && list.id && list.name); // Фильтруем валидные списки
  } catch (error) {
    console.error('Ошибка при получении списков из Planka:', error.response?.data || error.message);
    return [];
  }
}
// Поиск пользователя по email в Planka
async function findUserByEmail(email) {
  try {
    const accessToken = await getPlankaAccessToken();

    const response = await axios.get(
      `${process.env.PLANKA_BASE_URL}/users`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        timeout: 10000
      }
    );

    if (!response.data || !response.data.items) {
      console.error('Неверная структура ответа при поиске пользователей:', response.data);
      return null;
    }

    const users = response.data.items;
    const user = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase());

    return user || null;
  } catch (error) {
    console.error('Ошибка при поиске пользователя по email:', error.response?.data || error.message);
    return null;
  }
}

// Проверка пароля пользователя в Planka
async function verifyUserPassword(email, password) {
  try {
    const response = await axios.post(
      `${process.env.PLANKA_BASE_URL}/access-tokens`,
      {
        emailOrUsername: email,
        password: password
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    // Если запрос успешен, значит пароль правильный
    return {
      success: true,
      token: response.data.item,
      user: response.data.included?.users?.[0] || null
    };
  } catch (error) {
    // Если ошибка 401 - неправильный пароль
    if (error.response?.status === 401) {
      return {
        success: false,
        error: 'Неверный пароль'
      };
    }

    console.error('Ошибка при проверке пароля:', error.response?.data || error.message);
    return {
      success: false,
      error: 'Ошибка сервера при проверке пароля'
    };
  }
} 
// Функция для получения информации о пользователе по ID
async function getUserInfo(plankaUserId) {
  try {
    const accessToken = await getPlankaAccessToken();

    const response = await axios.get(
      `${process.env.PLANKA_BASE_URL}/users/${plankaUserId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    return response.data.item;
  } catch (error) {
    console.error('Ошибка получения информации о пользователе:', error);
    return null;
  }
}

// Создание пользователя в Planka
async function createPlankaUser(userData) {
  const accessToken = await getPlankaAccessToken();

  const response = await axios.post(
    `${process.env.PLANKA_BASE_URL}/users`,
    userData,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000
    }
  );

  if (!response.data || !response.data.item) {
    throw new Error('Неверный ответ при создании пользователя');
  }

  return response.data.item;
}

// Добавление пользователя к доске
async function addUserToBoard(plankaUserId) {
  const accessToken = await getPlankaAccessToken();

  const membershipData = {
    userId: String(plankaUserId),
    role: 'editor'
  };

  await axios.post(
    `${process.env.PLANKA_BASE_URL}/boards/${process.env.PLANKA_BOARD_ID}/memberships`,
    membershipData,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000
    }
  );
}


async function removeLabelFromCard(cardId, labelId) {
  try {
    const accessToken = await getPlankaAccessToken();

    // Сначала получаем все лейблы карточки, чтобы найти нужный cardLabel
    const cardLabels = await getCardLabels(cardId);
    const cardLabel = cardLabels.find(cl => cl.labelId === labelId);

    if (!cardLabel) {
      console.log('Лейбл не найден на карточке');
      return;
    }
    console.log("cardLabel.id", cardLabel.id);

    const response = await axios.delete(
      `${process.env.PLANKA_BASE_URL}/cards/${cardId}/labels/${cardLabel.labelId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Ошибка удаления лейбла с карточки:', error.response?.data || error.message);
    throw error;
  }
}

// Получение всех лейблов с доски
async function getBoardLabels() {
  try {
    const accessToken = await getPlankaAccessToken();

    const response = await axios.get(
      `${process.env.PLANKA_BASE_URL}/boards/${process.env.PLANKA_BOARD_ID}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    if (!response.data || !response.data.included) {
      console.error('Неверная структура ответа от Planka:', response.data);
      return [];
    }

    const labels = response.data.included.labels || [];
    console.log('Получено лейблов из Planka:', labels.length);

    return labels.filter(label => label && label.id && label.name);
  } catch (error) {
    console.error('Ошибка при получении лейблов из Planka:', error.response?.data || error.message);
    return [];
  }
}

// Функция для определения приоритета по лейблу
function getPriorityFromLabels(labels, requestedPriority = null) {
  // Создаем маппинг приоритетов
  const priorityMapping = {
    'высокий': ['высокий', 'high', 'срочно', 'критический', 'urgent', 'critical'],
    'средний': ['средний', 'medium', 'normal', 'обычный'],
    'низкий': ['низкий', 'low', 'не срочно', 'можно позже']
  };

  // Если приоритет указан в запросе, ищем соответствующий лейбл
  if (requestedPriority) {
    const normalizedRequest = requestedPriority.toLowerCase();

    for (const [priority, variations] of Object.entries(priorityMapping)) {
      if (variations.some(variant => normalizedRequest.includes(variant))) {
        // Ищем лейбл с таким приоритетом
        const matchingLabel = labels.find(label =>
          variations.some(variant => label.name.toLowerCase().includes(variant))
        );

        if (matchingLabel) {
          return {
            labelId: matchingLabel.id,
            priority: priority,
            labelName: matchingLabel.name
          };
        }
      }
    }
  }

  // Если не указан приоритет или не найден, возвращаем средний приоритет
  const defaultLabel = labels.find(label =>
    priorityMapping['средний'].some(variant =>
      label.name.toLowerCase().includes(variant)
    )
  );

  if (defaultLabel) {
    return {
      labelId: defaultLabel.id,
      priority: 'средний',
      labelName: defaultLabel.name
    };
  }

  // Если вообще нет подходящих лейблов, возвращаем null
  return null;
}

// Функция добавления лейбла к карточке
async function addLabelToCard(cardId, labelId) {
  try {
    const accessToken = await getPlankaAccessToken();

    const response = await axios.post(
      `${process.env.PLANKA_BASE_URL}/cards/${cardId}/labels`,
      {
        labelId: labelId
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Ошибка добавления лейбла к карточке:', error.response?.data || error.message);
    throw error;
  }
}

// Функция получения лейблов карточки
async function getCardLabels(cardId) {
  try {
    const accessToken = await getPlankaAccessToken();

    const response = await axios.get(
      `${process.env.PLANKA_BASE_URL}/cards/${cardId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    return response.data.included.cardLabels || [];
  } catch (error) {
    console.error('Ошибка получения лейблов карточки:', error);
    return [];
  }
}


// Создание карточки
async function createCard(listId, cardData) {
  const accessToken = await getPlankaAccessToken();

  const response = await axios.post(
    `${process.env.PLANKA_BASE_URL}/lists/${listId}/cards`,
    cardData,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.data || !response.data.item) {
    throw new Error('Неверный ответ при создании карточки');
  }

  return response.data.item;
}

// Назначение исполнителя карточки
async function assignCardMember(cardId, userId) {
  const accessToken = await getPlankaAccessToken();

  const membershipData = {
    userId: String(userId)
  };

  await axios.post(
    `${process.env.PLANKA_BASE_URL}/cards/${cardId}/memberships`,
    membershipData,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// Получение информации о карточке
async function getCard(cardId) {
  const accessToken = await getPlankaAccessToken();

  const response = await axios.get(
    `${process.env.PLANKA_BASE_URL}/cards/${cardId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );

  return response.data.item;
}

// Перемещение карточки
async function moveCard(cardId, listId) {
  const accessToken = await getPlankaAccessToken();

  await axios.patch(
    `${process.env.PLANKA_BASE_URL}/cards/${cardId}`,
    {
      listId,
      position: 1
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// Обновление карточки
async function updateCard(cardId, updateData) {
  const accessToken = await getPlankaAccessToken();

  await axios.patch(
    `${process.env.PLANKA_BASE_URL}/cards/${cardId}`,
    updateData,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

// Удаление карточки
async function deleteCard(cardId) {
  const accessToken = await getPlankaAccessToken();

  await axios.delete(
    `${process.env.PLANKA_BASE_URL}/cards/${cardId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
}

// Получение файлов карточки
async function getCardAttachments(cardId) {
  const accessToken = await getPlankaAccessToken();

  const response = await axios.get(
    `${process.env.PLANKA_BASE_URL}/cards/${cardId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );

  return response.data.included.attachments || [];
}

// Удаление вложения
async function deleteAttachment(attachmentId) {
  const accessToken = await getPlankaAccessToken();

  await axios.delete(
    `${process.env.PLANKA_BASE_URL}/attachments/${attachmentId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
}

// Получение списка
async function getList(listId) {
  const accessToken = await getPlankaAccessToken();

  const response = await axios.get(
    `${process.env.PLANKA_BASE_URL}/lists/${listId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );

  return response.data.item;
}

// Получение пользователя
async function getUser(userId) {
  const accessToken = await getPlankaAccessToken();

  const response = await axios.get(
    `${process.env.PLANKA_BASE_URL}/users/${userId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );

  return response.data;
}

module.exports = {
  getPlankaAccessToken,
  getPlankaLists,
  getUserInfo,
  createPlankaUser,
  addUserToBoard,
  createCard,
  assignCardMember,
  getCard,
  moveCard,
  updateCard,
  deleteCard,
  getCardAttachments,
  deleteAttachment,
  getList,
  getUser,
  getBoardLabels,
  getPriorityFromLabels,
  addLabelToCard,
  getCardLabels,
  removeLabelFromCard,
  findUserByEmail,
  verifyUserPassword
};