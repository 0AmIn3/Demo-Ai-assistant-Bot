//routes.js
const express = require('express');
const { loadDB, saveDB } = require('../database/db');


const router = express.Router();

// Регистрация владельца и создание ссылки
router.post('/register-owner', async (req, res) => {
  const { telegramGroupId } = req.body;

  if (!telegramGroupId) {
    return res.status(400).json({ error: 'telegramGroupId is required' });
  }

  const db = loadDB();
  const ownerId = Date.now().toString();

  let inviteLink;
  try {
    // Получаем bot из контекста приложения
    const bot = req.app.get('telegramBot');
    inviteLink = await bot.exportChatInviteLink(telegramGroupId);
  } catch (error) {
    console.error('Error generating invite link:', error);
    return res.status(400).json({
      error: 'Unable to generate invite link. Ensure bot is group admin.',
      details: error.message
    });
  }

  let groupInfo;
  try {
    const bot = req.app.get('telegramBot');
    groupInfo = await bot.getChat(telegramGroupId);
  } catch (error) {
    console.error('Error getting group info:', error);
    groupInfo = { title: 'Unknown Group' };
  }

  const ownerData = {
    id: ownerId,
    telegramGroupId,
    inviteLink,
    groupTitle: groupInfo.title,
    createdAt: new Date().toISOString()
  };

  db.owners.push(ownerData);
  saveDB(db);

  const bot = req.app.get('telegramBot');
  const botInfo = await bot.getMe();
  const startLink = `https://t.me/${botInfo.username}?start=${ownerId}`;

  res.json({
    startLink,
    groupTitle: groupInfo.title,
    ownerId
  });
});

// Получение списка групп
router.get('/groups', (req, res) => {
  const db = loadDB();
  const groups = db.owners.map(owner => ({
    id: owner.id,
    groupId: owner.telegramGroupId,
    groupTitle: owner.groupTitle,
    employeeCount: db.employees.filter(emp => emp.ownerId === owner.id).length,
    createdAt: owner.createdAt
  }));
  res.json(groups);
});

// Получение списка сотрудников
router.get('/employees', (req, res) => {
  const db = loadDB();
  const employees = db.employees.map(emp => ({
    name: emp.name,
    email: emp.email,
    position: emp.position,
    groupTitle: emp.groupTitle,
    registrationDate: emp.registrationDate
  }));
  res.json(employees);
});

// Получение истории задач
router.get('/tasks', (req, res) => {
  const db = loadDB();
  res.json(db.taskHistory || []);
});

module.exports = router;