const { loadDB } = require('../../database/db');

// Поиск исполнителя в базе данных по информации от Gemini
function findAssigneeInDatabase(assigneeInfo) {
  if (!assigneeInfo || !assigneeInfo.mentioned) {
    return null;
  }

  const db = loadDB();
  const employees = db.employees || []; // Берем всех сотрудников

  if (employees.length === 0) {
    return null;
  }

  // Если указан email
  if (assigneeInfo.email) {
    const foundByEmail = employees.find(emp =>
      emp.email.toLowerCase() === assigneeInfo.email.toLowerCase()
    );
    if (foundByEmail) {
      return foundByEmail;
    }
  }

  // Если указано имя
  if (assigneeInfo.name) {
    const name = assigneeInfo.name.toLowerCase();

    // Точное совпадение по полному имени
    const foundByFullName = employees.find(emp =>
      emp.name.toLowerCase() === name
    );
    if (foundByFullName) {
      return foundByFullName;
    }

    // Поиск по частичному совпадению имени
    const foundByPartialName = employees.find(emp =>
      emp.name.toLowerCase().includes(name) ||
      name.includes(emp.name.toLowerCase())
    );
    if (foundByPartialName) {
      return foundByPartialName;
    }

    // Поиск по первому имени (до первого пробела)
    const firstName = name.split(' ')[0];
    const foundByFirstName = employees.find(emp =>
      emp.name.toLowerCase().split(' ')[0] === firstName
    );
    if (foundByFirstName) {
      return foundByFirstName;
    }
  }

  // Поиск по дополнительным терминам поиска
  if (assigneeInfo.searchTerms && Array.isArray(assigneeInfo.searchTerms)) {
    for (const term of assigneeInfo.searchTerms) {
      const lowerTerm = term.toLowerCase();

      const foundByTerm = employees.find(emp =>
        emp.name.toLowerCase().includes(lowerTerm) ||
        lowerTerm.includes(emp.name.toLowerCase()) ||
        emp.email.toLowerCase().includes(lowerTerm) ||
        (emp.position && emp.position.toLowerCase().includes(lowerTerm))
      );

      if (foundByTerm) {
        return foundByTerm;
      }
    }
  }

  return null;
}


// Создание сообщения о найденном исполнителе
function createAssigneeFoundMessage(employee, originalInfo) {
  return `👤 Автоматически найден исполнитель: *${employee.name}* (${employee.position || 'Должность не указана'})`;
}

// Создание сообщения о том, что исполнитель не найден
function createAssigneeNotFoundMessage(assigneeInfo) {
  let message = '❓ Исполнитель упомянут, но не найден в базе данных:\n';

  if (assigneeInfo.name) {
    message += `• Имя: ${assigneeInfo.name}\n`;
  }
  if (assigneeInfo.email) {
    message += `• Email: ${assigneeInfo.email}\n`;
  }
  if (assigneeInfo.searchTerms && assigneeInfo.searchTerms.length > 0) {
    message += `• Дополнительные термины: ${assigneeInfo.searchTerms.join(', ')}\n`;
  }

  message += '\nВыберите исполнителя из списка зарегистрированных сотрудников:';

  return message;
}

module.exports = {
  findAssigneeInDatabase,
  createAssigneeFoundMessage,
  createAssigneeNotFoundMessage
};