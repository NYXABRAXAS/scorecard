'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../../config/db');
const env = require('../../config/env');
const ApiError = require('../../utils/ApiError');

function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, employeeId: user.employee_id, label: user.full_name, role: user.role_code, branchCode: user.branch_code },
    env.jwt.secret,
    { expiresIn: env.jwt.accessTokenTtl }
  );
}

function signRefreshToken(user) {
  return jwt.sign({ id: user.id, type: 'refresh' }, env.jwt.secret, { expiresIn: env.jwt.refreshTokenTtl });
}

const authService = {
  async login(employeeId, password) {
    const { rows } = await query(`SELECT * FROM app_user WHERE employee_id = $1 AND is_active = TRUE`, [employeeId]);
    const user = rows[0];
    if (!user) throw ApiError.unauthorized('Invalid employee ID or password.');

    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) throw ApiError.unauthorized('Invalid employee ID or password.');

    return {
      accessToken: signAccessToken(user),
      refreshToken: signRefreshToken(user),
      expiresIn: env.jwt.accessTokenTtl,
      user: { id: user.id, employeeId: user.employee_id, fullName: user.full_name, role: user.role_code, branchCode: user.branch_code }
    };
  },

  async refresh(refreshToken) {
    let payload;
    try {
      payload = jwt.verify(refreshToken, env.jwt.secret);
    } catch (err) {
      throw ApiError.unauthorized('Invalid or expired refresh token.');
    }
    if (payload.type !== 'refresh') throw ApiError.unauthorized('Not a refresh token.');

    const { rows } = await query(`SELECT * FROM app_user WHERE id = $1 AND is_active = TRUE`, [payload.id]);
    const user = rows[0];
    if (!user) throw ApiError.unauthorized('User no longer active.');

    return { accessToken: signAccessToken(user), expiresIn: env.jwt.accessTokenTtl };
  }
};

module.exports = authService;
