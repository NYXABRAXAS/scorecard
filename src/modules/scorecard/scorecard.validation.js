'use strict';

const Joi = require('joi');

/**
 * One answered parameter for a person — see score_card_person_responses table.
 * QUANTITATIVE parameters are answered by selecting exactly one option
 * (selectedOptionId); QUALITATIVE parameters are a yes/no flag (qualitativeFlag).
 * Exactly one of the two must be present per entry; which one is valid for a
 * given parameterId is enforced downstream by creditScoreEngine.js against the
 * parameter's actual category (a client cannot mix them up and have it silently
 * accepted). A response array may be a partial subset of all parameters for a
 * profile — unanswered parameters simply score 0 (draft-in-progress state).
 */
const personResponseSchema = Joi.object({
  parameterId: Joi.number().integer().positive().required(),
  selectedOptionId: Joi.number().integer().positive(),
  qualitativeFlag: Joi.boolean()
}).xor('selectedOptionId', 'qualitativeFlag');

/**
 * One subscriber/guarantor person — see score_card_persons table. profileType
 * selects which of the two independent score cards (Employee/Salaried or
 * Business) this person's responses are validated and scored against; see
 * db/seed_credit_score.sql / DOCUMENTATION.md Section 19 for the full
 * Excel-to-parameter mapping.
 */
const personSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  profileType: Joi.string().valid('SALARIED', 'BUSINESS').required(),
  responses: Joi.array().items(personResponseSchema).unique('parameterId').default([])
});

/**
 * One security/collateral row. `valueLoaded` (the Accepted Value) is ALWAYS
 * server-computed from the type-specific raw inputs below — per the FRD Section
 * 6.1 Accepted Value Formula table — never trusted as raw client input (a client
 * could otherwise submit any valueLoaded and bypass the accepted-value rule
 * entirely). Which of the optional fields below are actually required depends on
 * securityType; that per-type check happens in securityValuation.js, not here,
 * since a 9-way Joi.when() chain is far less readable than one lookup table.
 */
const securitySchema = Joi.object({
  securityType: Joi.string().valid(...require('./securityValuation').SECURITY_TYPES).required(),
  holderName: Joi.string().max(120).allow('', null),
  loyaltyUsn: Joi.string().max(40).allow('', null),
  // Gold Ornaments
  netWeightGrams: Joi.number().min(0),
  ratePerGram: Joi.number().min(0),
  // LIC Policy
  surrenderValue: Joi.number().min(0),
  // Bank Guarantee / Fixed Deposit / Demat NCD
  faceValue: Joi.number().min(0),
  // Sub-Debt / Chit Passbook ("As per API")
  apiSourcedValue: Joi.number().min(0),
  maturityDate: Joi.date().iso(),
  // Mortgage (Property)
  forcedSaleValue: Joi.number().min(0),
  // Demat Shares
  marketValue: Joi.number().min(0),
  liabilityToSecure: Joi.number().min(0)
});

const createScoreCardSchema = Joi.object({
  applicationId: Joi.string().pattern(/^MCF-\d{4}-\d{6}$/).required()
    .messages({ 'string.pattern.base': 'applicationId must match MCF-YYYY-NNNNNN' }),
  chitValue: Joi.number().positive().required(), // also the proposed loan amount for the Security Coverage guard
  futureLiability: Joi.number().positive().required(),
  documentsComplete: Joi.boolean().default(false),
  subscriber: personSchema.required(),
  guarantors: Joi.array().items(personSchema).max(4).default([]),
  securities: Joi.array().items(securitySchema).min(1).required()
});

// Update allows the same shape but every top-level field is optional (partial update).
const updateScoreCardSchema = Joi.object({
  chitValue: Joi.number().positive(),
  futureLiability: Joi.number().positive(),
  documentsComplete: Joi.boolean(),
  subscriber: personSchema,
  guarantors: Joi.array().items(personSchema).max(4),
  securities: Joi.array().items(securitySchema).min(1),
  remarks: Joi.string().max(2000).allow('', null)
}).min(1);

const rejectSchema = Joi.object({
  rejectionReason: Joi.string().trim().min(5).max(2000).required()
});

const approveSchema = Joi.object({
  remarks: Joi.string().trim().max(2000).allow('', null)
});

const documentUploadSchema = Joi.object({
  documentType: Joi.string()
    .valid('DPN', 'KYC', 'Gold Appraisal', 'Income Proof', 'Address Proof', 'Bank Statement', 'Other')
    .required(),
  fileName: Joi.string().max(255).required(),
  fileUrl: Joi.string().uri().required(),
  mimeType: Joi.string().max(100).optional(),
  fileSizeBytes: Joi.number().integer().min(1).max(25 * 1024 * 1024) // 25MB cap
    .messages({ 'number.max': 'File exceeds the 25MB upload limit' })
    .optional()
});

const idParamSchema = Joi.object({
  id: Joi.string().guid({ version: 'uuidv4' }).required()
});

const applicationIdParamSchema = Joi.object({
  applicationId: Joi.string().pattern(/^MCF-\d{4}-\d{6}$/).required()
});

const listQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid('DRAFT', 'VALIDATED', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'),
  applicationId: Joi.string(),
  createdBy: Joi.number().integer(),
  sort: Joi.string().pattern(/^[a-z_]+:(asc|desc)$/i),
  fromDate: Joi.date().iso(),
  toDate: Joi.date().iso()
});

module.exports = {
  createScoreCardSchema,
  updateScoreCardSchema,
  rejectSchema,
  approveSchema,
  documentUploadSchema,
  idParamSchema,
  applicationIdParamSchema,
  listQuerySchema,
  personSchema,
  personResponseSchema,
  securitySchema
};
