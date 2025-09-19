//routes.js
const express = require('express');
const { loadDB, saveDB } = require('../database/db');


const router = express.Router();

// Регистрация владельца и создание ссылки
router.post('/register-owner', async (req, res) => {


  const db = loadDB();
  const ownerId = Date.now().toString(); // простой уникальный id


  // --- 2. заголовок группы ------------------------------------------
  let groupInfo = { title: 'Unknown group' };
 

  // --- 3. сохраняем владельца (пока без username / chatId) ----------
  db.owners.push({
    id: ownerId,
    telegramGroupId: null,
    inviteLink: null,
    groupTitle: groupInfo.title,
    username: null,
    chatId: null,
    createdAt: new Date().toISOString()
  });
  saveDB(db);

  // --- 4. отдаём ссылку на регистрационного бота --------------------
  const regBot = req.app.get('registrationBot');
  const regInfo = await regBot.getMe();
  const startLink = `https://t.me/${regInfo.username}?start=${ownerId}`;

  return res.json({
    ownerId,
    groupTitle: groupInfo.title,
    startLink
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