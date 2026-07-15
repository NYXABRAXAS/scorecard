'use strict';

const ApiError = require('./ApiError');

const MAX_PAGE_SIZE = 100;

/** Parses & validates page/pageSize/sort/filter query params shared by every list endpoint. */
function parseListQuery(query, { sortableFields = [], defaultSort = 'created_at' } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.pageSize, 10) || 20));

  let sortField = defaultSort;
  let sortDir = 'DESC';
  if (query.sort) {
    const [field, dir] = String(query.sort).split(':');
    if (sortableFields.length && !sortableFields.includes(field)) {
      throw ApiError.badRequest('INVALID_SORT_FIELD', `Cannot sort by "${field}". Allowed: ${sortableFields.join(', ')}`);
    }
    sortField = field;
    sortDir = (dir || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  }

  return { page, pageSize, offset: (page - 1) * pageSize, sortField, sortDir };
}

module.exports = { parseListQuery, MAX_PAGE_SIZE };
