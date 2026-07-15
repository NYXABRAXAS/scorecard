'use strict';

const Joi = require('joi');

const EMPLOYMENT_TYPES = [
  'Salaried-Govt', 'Salaried-PSU', 'Salaried-Private',
  'Business', 'Self Employed - Professional', 'Agriculture', 'Other'
];
const ENTITY_TYPES = ['PvtLtd', 'Partnership', 'Proprietorship'];

/** One subscriber/guarantor person — see score_card_persons table. */
const personSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  employmentType: Joi.string().valid(...EMPLOYMENT_TYPES).required(),
  entityType: Joi.string().valid(...ENTITY_TYPES).when('employmentType', {
    is: 'Business',
    then: Joi.optional(),
    otherwise: Joi.forbidden()
  }),
  yearsInBusiness: Joi.number().min(0).max(80).optional(),
  yearsOfService: Joi.number().min(0).max(60).optional(),
  employeeCount: Joi.number().integer().min(0).optional(),
  staffCount: Joi.number().integer().min(0).optional(),
  permanentGovt: Joi.boolean().optional(),
  customerVintageYears: Joi.number().min(0).max(80).optional(),
  personalVisits: Joi.number().integer().min(0).max(999).default(0),
  propertyCount: Joi.number().integer().min(0).max(50).default(0),
  propertyValue: Joi.number().min(0).max(999999999999).default(0),
  creditScore: Joi.number().integer().min(300).max(900).allow(null),
  foir: Joi.number().min(0).max(3).required(), // ratio 0-1 normally, capped generously to allow >100% edge case
  grossIncome: Joi.number().min(0).optional(),
  netIncome: Joi.number().min(0).optional(),
  directExposure: Joi.number().min(0).default(0),
  indirectExposure: Joi.number().min(0).default(0),
  suitFiled: Joi.boolean().default(false),
  prlFlag: Joi.boolean().default(false),
  cc3Flag: Joi.boolean().default(false),
  chequeBounceCount: Joi.number().integer().min(0).max(999).default(0)
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
  chitValue: Joi.number().positive().required(),
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
  riskGrade: Joi.string().valid('A', 'B', 'C', 'D'),
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
  securitySchema
};
