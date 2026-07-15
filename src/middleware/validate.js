'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Generic Joi-schema validation middleware.
 * Usage: router.post('/', validate(schema, 'body'), controller.create)
 */
function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
      convert: true
    });
    if (error) {
      const details = error.details.map((d) => ({ field: d.path.join('.'), message: d.message }));
      return next(ApiError.validation(details));
    }
    req[property] = value;
    next();
  };
}

module.exports = validate;
