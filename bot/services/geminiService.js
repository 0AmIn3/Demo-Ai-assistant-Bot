const { loadDB } = require('../../database/db');
const plankaService = require('./plankaService');

// Анализ сообщения с помощью Gemini AI через fetch
async function analyzeMessageWithGemini(message, userName, chatId) {
  try {
    const db = loadDB();
    const employees = db.employees || [];

    // Получаем доступные лейблы приоритетов из Planka
    const boardLabels = await plankaService.getBoardLabels();
    const priorityLabels = boardLabels.filter(label =>
      ['высокий', 'средний', 'низкий', 'high', 'medium', 'low', 'срочно', 'urgent', 'critical', 'критический'].some(priority =>
        label.name.toLowerCase().includes(priority)
      )
    );

    // Формируем список всех сотрудников для промпта
    const employeeList = employees.map(emp => {
      return `- ${emp.name} (${emp.position || 'должность не указана'}, email: ${emp.email})`;
    }).join('\n');

    // Формируем список доступных приоритетов
    const priorityList = priorityLabels.map(label => `- ${label.name}`).join('\n');


    const prompt = `
Анализируй это сообщение для создания задачи в канбан-доске. 
Сообщение от пользователя ${userName}: "${message}"

ТЕКУЩАЯ ДАТА И ВРЕМЯ: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long' })} (Ташкент, UTC+5)

ДОСТУПНЫЕ СОТРУДНИКИ В ЭТОЙ ГРУППЕ:
${employeeList || 'Нет зарегистрированных сотрудников'}

ДОСТУПНЫЕ ПРИОРИТЕТЫ (ЛЕЙБЛЫ) В СИСТЕМЕ:
${priorityList || 'Нет доступных лейблов приоритета'}

Определи:
1. Название задачи (краткое, до 50 символов)
2. Описание задачи (подробное)
3. Приоритет (ОБЯЗАТЕЛЬНО выбери из списка доступных лейблов выше, если не указан явно - используй средний приоритет)
4. Категория работы (разработка/дизайн/тестирование/документация/другое)
5. Предполагаемый исполнитель (ТОЛЬКО из списка выше)
6. Срок выполнения (если упомянут в сообщении)

ПРАВИЛА ДЛЯ ПРИОРИТЕТА:
- Если в сообщении есть слова "срочно", "критично", "важно", "ASAP", "быстро", "немедленно" - выбирай высокий приоритет
- Если есть слова "не спешить", "когда будет время", "не срочно", "медленно" - выбирай низкий приоритет  
- В остальных случаях - средний приоритет
- ОБЯЗАТЕЛЬНО используй только те названия лейблов, которые есть в списке выше
- Если подходящего лейбла нет, используй "средний" как значение по умолчанию

ВАЖНО: 
- Сообщение может быть на русском или узбекском языке. Определи язык сообщения и возвращай название и описание на том же языке.
- Если сообщение является транскрибированным голосом, обрабатывай его как текст.
- Если в сообщении упоминается конкретный человек как исполнитель (например: "дай Азизу", "пусть Алексей сделает", "назначь на Марию", "для Джона"), проверь, есть ли он в списке доступных сотрудников выше.
- ИГНОРИРУЙ любые упоминания людей, которых НЕТ в списке доступных сотрудников.
- Если упомянутый человек НЕ найден в списке, установи mentioned: false.
- Для срока выполнения используй ТЕКУЩУЮ ДАТУ ВЫШЕ как отправную точку:
  * "до завтра" = завтрашний день в 18:00 по Ташкенту
  * "к концу недели" = ближайшая пятница в 18:00 по Ташкенту  
  * "до понедельника" = следующий понедельник в 10:00 по Ташкенту
  * "через 3 дня" = текущая дата + 3 дня в 18:00 по Ташкенту
  * "срочно" = сегодня в 23:59 по Ташкенту
  * Если точное время указано, используй его по времени Ташкента
- Переводи время в UTC формат (Ташкент UTC+5, поэтому вычитай 5 часов)
- Слова 'помощник', 'ассистент', 'ердамчи', 'pomoshnik', 'asistant', 'yordamchi', 'ёрдамчи', 'asistent' не учитывай как исполнителей.

ПРИМЕРЫ ПРЕОБРАЗОВАНИЯ ВРЕМЕНИ:
- 18:00 по Ташкенту = 13:00 UTC = 2025-04-24T13:00:00.000Z
- 10:00 по Ташкенту = 05:00 UTC = 2025-04-24T05:00:00.000Z

Если информация неясна или отсутствует:
- Установи needsMoreInfo: true, если задача не может быть полностью определена (например, нет исполнителя или неясный срок).
- Если приоритет не указан, используй средний приоритет.
- Если исполнитель не упомянут, установи assigneeInfo.mentioned: false и assigneeInfo.name: null.

Ответь в JSON формате:
{
  "title": "название задачи",
  "description": "подробное описание четко о задаче, не пиши уточнения и тд только суть",
  "priority": "ТОЧНОЕ название лейбла из списка доступных приоритетов выше",
  "category": "категория",
  "assigneeInfo": {
    "mentioned": true/false,
    "name": "имя исполнителя из списка или null",
    "email": "email исполнителя из списка или null",
    "dueDate": "срок выполнения в формате 2025-04-24T13:00:00.000Z (UTC) или null если не указан",
    "searchTerms": ["возможные варианты поиска исполнителя из списка, если mentioned: true"]
  },
  "needsMoreInfo": true/false
}

- Не думай о том, реалистично это или нет, просто создай задачу на основе данных.
- Не указывай, кто сказал или как запросил задачу.
`;


    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates[0].content.parts[0].text;

    // Извлекаем JSON из ответа
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);

      // Дополнительно обрабатываем приоритет через нашу систему лейблов
      const priorityInfo = plankaService.getPriorityFromLabels(boardLabels, analysis.priority);
      if (priorityInfo) {
        analysis.priorityInfo = priorityInfo;
      }

      return analysis;
    }

    throw new Error('Не удалось распарсить ответ от Gemini');
  } catch (error) {
    console.error('Ошибка анализа с Gemini:', error);
    return null;
  }
}

module.exports = {
  analyzeMessageWithGemini
};