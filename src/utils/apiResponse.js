'use strict';

/** Uniform success envelope used by every 2xx response across the API. */
function ok(res, data, meta, statusCode = 200) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

function created(res, data, meta) {
  return ok(res, data, meta, 201);
}

function noContent(res) {
  return res.status(204).send();
}

/** Uniform pagination meta block. */
function paginationMeta({ page, pageSize, totalRecords }) {
  return {
    page,
    pageSize,
    totalRecords,
    totalPages: Math.max(1, Math.ceil(totalRecords / pageSize))
  };
}

module.exports = { ok, created, noContent, paginationMeta };
