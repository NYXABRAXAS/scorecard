'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Role -> feature permission matrix. Mirrors assets/json/roles-permissions.json
 * exactly (also seeded into role_master.permissions for reference/admin screens) —
 * kept as a JS constant here too so route wiring doesn't need a DB round-trip on
 * every request just to authorize it.
 */
const ROLE_PERMISSIONS = {
  BI:    ['caseCreate', 'caseEdit', 'caseSubmit', 'caseViewOwn', 'docUpload', 'reportsView'],
  BS:    ['caseViewAll', 'caseApprove', 'caseReject', 'caseReturn', 'docVerify', 'docRequest', 'reportsView'],
  HUB:   ['caseViewAll', 'docVerify', 'fiAssign', 'reportsView'],
  FI:    ['fiAccept', 'fiVisit', 'fiSubmitReport', 'caseViewOwn', 'reportsView'],
  FC:    ['caseViewAll', 'camView', 'camGenerate', 'camEdit', 'financialAnalysis', 'riskAnalysis', 'caseApprove', 'caseReject', 'caseReturn', 'reportsView'],
  DEV:   ['caseViewAll', 'camView', 'deviationApprove', 'deviationReject', 'reportsView'],
  RA:    ['caseViewAll', 'camView', 'camEdit', 'caseApprove', 'caseReject', 'caseHold', 'reportsView'],
  CH:    ['caseViewAll', 'camView', 'camEdit', 'caseApprove', 'caseReject', 'loanModify', 'roiModify', 'tenureModify', 'reportsView'],
  FA:    ['caseViewAll', 'camView', 'caseApprove', 'caseReject', 'reportsView'],
  BA:    ['caseViewAll', 'camView', 'caseApprove', 'caseReject', 'caseHold', 'reportsView'],
  DISB:  ['caseViewAll', 'sanctionLetter', 'agreementGenerate', 'nachUpload', 'loanAccountGenerate', 'disburse', 'reportsView'],
  ADMIN: ['*'] // wildcard: ADMIN can perform every feature, matching Permissions.canPerform in the existing LOS
};

function roleHasPermission(role, feature) {
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  return perms.includes('*') || perms.includes(feature);
}

/** Express middleware factory: requirePermission('camEdit') etc. */
function requirePermission(feature) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roleHasPermission(req.user.role, feature)) {
      return next(ApiError.forbidden(`Role "${req.user.role}" does not have the "${feature}" permission required for this action.`));
    }
    next();
  };
}

/**
 * Row-level ownership check: BI/FI hold only caseViewOwn, so they may act on a
 * score card only if they created it (or it's assigned to their branch); every
 * other role with caseViewAll may act on any record.
 *
 * `getOwnerId(req)` must return:
 *   - the owning user's id, if the record exists
 *   - `undefined` if the record does NOT exist — this deliberately lets the
 *     request fall through to the controller so the standard 404 (not the
 *     wrong 403) is what the caller sees for a non-existent resource.
 */
function requireOwnershipOrViewAll(getOwnerId) {
  return async (req, res, next) => {
    const perms = ROLE_PERMISSIONS[req.user.role] || [];
    if (perms.includes('*') || perms.includes('caseViewAll')) return next();
    try {
      const ownerId = await getOwnerId(req);
      if (ownerId === undefined) return next(); // not found -> let the 404 downstream handle it
      if (ownerId === req.user.id) return next();
      return next(ApiError.forbidden('You may only access score cards you created.'));
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { ROLE_PERMISSIONS, roleHasPermission, requirePermission, requireOwnershipOrViewAll };
