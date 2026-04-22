'use strict';

/**
 * server/lib/classificationFeedback.cjs
 *
 * Phase 4 integration for classification feedback. After each thumbs-down
 * insert, checks for 2+ same-pattern corrections and auto-generates
 * inferred classification rules (suppress-only).
 *
 * Pattern specificity order:
 *   1. Same sender_email + same correction_dimension
 *   2. Same sender_domain + same correction_dimension
 *   3. Same subject_pattern (future — not yet implemented)
 *
 * Thumbs-up aggregation: 3+ positives on same sender → boost confidence
 * (logged to decision_log, no user-visible change).
 *
 * Safety: inferred rules ONLY suppress dimensions, never add new
 * classifications. Decays via same 0.95^days mechanics as behavior rules.
 */

const logger = require('../../guardrails/logger.cjs');

const MIN_NEGATIVE_SIGNALS = 2;
const MIN_POSITIVE_SIGNALS = 3;

/**
 * Fire-and-forget after every classification_feedback insert.
 * Checks for pattern matches and generates inferred rules if threshold met.
 */
async function processClassificationFeedback(db, userId, feedback) {
  try {
    if (!feedback || !db) return;

    const { feedbackType, senderEmail, senderDomain, correctionDimensions } = feedback;

    if (feedbackType === 'thumbs_down' && correctionDimensions) {
      // Check each correction dimension for pattern matches
      const dimensions = Object.keys(correctionDimensions).filter(k => correctionDimensions[k]);

      for (const dim of dimensions) {
        // 1. Check sender_email pattern (most specific)
        if (senderEmail) {
          const emailCount = await db.getClassificationFeedbackByPattern(userId, 'sender_email', senderEmail, dim);
          if (emailCount >= MIN_NEGATIVE_SIGNALS) {
            const rule = await db.upsertInferredClassificationRule(userId, {
              patternType: 'sender_email',
              patternValue: senderEmail,
              suppressDimension: dim,
              strength: 0.3,
            });
            if (rule) {
              logger.info('classificationFeedback.inferredRule', {
                userId, patternType: 'sender_email', patternValue: senderEmail,
                suppressDimension: dim, signalCount: rule.signalCount,
              });
              // Log to decision_log for observability
              if (db.logDecision) {
                await db.logDecision(userId, {
                  actionType: 'auto_rule_classification',
                  toolCalled: 'infer_classification_rule',
                  toolInput: { patternType: 'sender_email', patternValue: senderEmail, suppressDimension: dim },
                  confidenceScore: rule.strength,
                  disposition: 'auto_allowed',
                  outcome: 'executed',
                  contextSummary: `Auto-generated suppress rule: ${dim} for ${senderEmail} (${rule.signalCount} signals)`,
                }).catch(() => {});
              }
              // Invalidate classification rule cache
              await invalidateClassificationRuleCache(db, userId);
            }
            continue; // Skip domain check if email matched (more specific wins)
          }
        }

        // 2. Check sender_domain pattern
        if (senderDomain) {
          const domainCount = await db.getClassificationFeedbackByPattern(userId, 'sender_domain', senderDomain, dim);
          if (domainCount >= MIN_NEGATIVE_SIGNALS) {
            const rule = await db.upsertInferredClassificationRule(userId, {
              patternType: 'sender_domain',
              patternValue: senderDomain,
              suppressDimension: dim,
              strength: 0.3,
            });
            if (rule) {
              logger.info('classificationFeedback.inferredRule', {
                userId, patternType: 'sender_domain', patternValue: senderDomain,
                suppressDimension: dim, signalCount: rule.signalCount,
              });
              if (db.logDecision) {
                await db.logDecision(userId, {
                  actionType: 'auto_rule_classification',
                  toolCalled: 'infer_classification_rule',
                  toolInput: { patternType: 'sender_domain', patternValue: senderDomain, suppressDimension: dim },
                  confidenceScore: rule.strength,
                  disposition: 'auto_allowed',
                  outcome: 'executed',
                  contextSummary: `Auto-generated suppress rule: ${dim} for @${senderDomain} (${rule.signalCount} signals)`,
                }).catch(() => {});
              }
              await invalidateClassificationRuleCache(db, userId);
            }
          }
        }
      }
    }

    // Positive reinforcement: 3+ thumbs-up on same sender → log confidence boost
    if (feedbackType === 'thumbs_up' && senderEmail) {
      const positiveCount = await db.getPositiveFeedbackCount(userId, 'sender_email', senderEmail);
      if (positiveCount >= MIN_POSITIVE_SIGNALS) {
        logger.info('classificationFeedback.positiveReinforcement', {
          userId, senderEmail, count: positiveCount,
        });
        // Log the reinforcement for observability — no user-visible change
        if (db.logDecision) {
          await db.logDecision(userId, {
            actionType: 'classification_reinforcement',
            toolCalled: null,
            toolInput: { senderEmail, positiveCount },
            confidenceScore: Math.min(1.0, 0.5 + positiveCount * 0.05),
            disposition: 'auto_allowed',
            outcome: 'executed',
            contextSummary: `Positive reinforcement for ${senderEmail} (${positiveCount} thumbs-up)`,
          }).catch(() => {});
        }
      }
    }
  } catch (err) {
    // Fire-and-forget — never break the feedback endpoint
    logger.warn('classificationFeedback.processFailed', { userId, error: err.message });
  }
}

/**
 * Invalidate the classification rule cache for a user.
 * Uses Redis if available, otherwise no-op.
 */
async function invalidateClassificationRuleCache(db, userId) {
  try {
    const { rediDel } = require('./redis.cjs');
    await rediDel(`cls_rules:${userId}`);
  } catch { /* Redis down — classifier will read from DB */ }
}

module.exports = { processClassificationFeedback, invalidateClassificationRuleCache };
