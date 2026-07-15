'use strict';

const Joi = require('joi');

const loginSchema = Joi.object({
  employeeId: Joi.string().trim().required(),
  password: Joi.string().min(6).required()
});

const refreshSchema = Joi.object({
  refreshToken: Joi.string().required()
});

module.exports = { loginSchema, refreshSchema };
