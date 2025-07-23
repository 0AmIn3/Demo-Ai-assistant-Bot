// Создание inline клавиатуры для выбора списка
function createListSelectionKeyboard(lists) {
  const keyboard = lists.map(list => ([{
    text: list.name,
    callback_data: `select_list_${list.id}`
  }]));

  keyboard.push([{
    text: '❌ Отмена',
    callback_data: 'cancel_task'
  }]);

  return { inline_keyboard: keyboard };
}

// Создание клавиатуры для выбора исполнителя
function createAssigneeKeyboard(employees) {
  const keyboard = employees.map(emp => {
    const buttonText = emp.name +
      (emp.position ? ` (${emp.position})` : '') +
      (emp.telegramUserId ? ' 📱' : '');

    return [{
      text: buttonText,
      callback_data: `select_assignee_${emp.plankaUserId}`
    }];
  });

  keyboard.push([{
    text: '👤 Без исполнителя',
    callback_data: 'select_assignee_none'
  }]);

  keyboard.push([{
    text: '❌ Отмена',
    callback_data: 'cancel_task'
  }]);

  return { inline_keyboard: keyboard };
}

module.exports = {
  createListSelectionKeyboard,
  createAssigneeKeyboard
};