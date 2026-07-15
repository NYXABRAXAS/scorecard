'use strict';

const authService = require('./auth.service');
const { ok } = require('../../utils/apiResponse');
const { asyncHandler } = require('../../middleware/errorHandler');

module.exports = {
  login: asyncHandler(async (req, res) => {
    const { employeeId, password } = req.body;
    const result = await authService.login(employeeId, password);
    ok(res, result);
  }),

  refresh: asyncHandler(async (req, res) => {
    const result = await authService.refresh(req.body.refreshToken);
    ok(res, result);
  })
};
