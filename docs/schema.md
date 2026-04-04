# Dizon.ai — Database Schema
Last updated: April 4, 2026

## Current Tables (live)
tasks, notes, note_categories, note_images, inbox_items,
users, entities, settings, preferences, chat_messages,
conversations, conversation_messages, financial_accounts,
transactions, gcal_tokens, gmail_tokens, gmail_config

## Phase 1 — New Tables (planned)
oauth_tokens        — consolidates gcal_tokens + gmail_tokens (provider enum)
integration_config  — per-user webhook config (replaces hardcoded env vars)
agent_memory        — episodic | semantic | procedural memory
agent_tasks         — every agent action logged here
agent_approvals     — high-stakes actions pause here for user approval

## Audit Fields (all new tables)
created_at, updated_at, created_by, updated_by

## Key Rules
- Never drop old tables until new endpoints are verified
- Build new tables alongside old during migration
- All tokens stored as JSONB, encrypted at rest (ENCRYPTION_KEY env var)
