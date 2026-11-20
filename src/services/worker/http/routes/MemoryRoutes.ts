import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { saveMemoryChecked } from '../../../memory/save-memory.js';
import { invalidateMemory } from '../../../memory/invalidate-memory.js';
import { logger } from '../../../../utils/logger.js';
import { getGitMemoryMetadata, getProjectContext } from '../../../../utils/project-name.js';
import { isProjectExcluded } from '../../../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../../shared/paths.js';
import { LESSON_CONCEPT, MEMORY_OUTCOMES } from '../../../../shared/memory-lesson.js';
import { isForeignBrowserRead, isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';
import { incrementCanonicalDecimal } from '../../../sync/CanonicalContent.js';
import { computeObservationContentHash } from '../../../sqlite/observations/store.js';
import { exportProjectLessons, parsePortableLessons, portableLessonInput } from '../../../memory/portable-lessons.js';
import { saveMemory } from '../../../memory/save-memory.js';

const saveMemorySchema = z.object({
  text: z.string().trim().min(1),
  title: z.string().optional(),
  project: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  outcome: z.enum(MEMORY_OUTCOMES).optional(),
  cause: z.string().optional(),
  lesson: z.string().optional(),
  supersedes: z.number().int().positive().optional(),
  cwd: z.string().optional(),
}).strict();

const invalidateMemorySchema = z.object({
  id: z.number().int().positive(),
  reason: z.string().optional(),
  replacedBy: z.number().int().positive().optional(),
  restore: z.boolean().optional(),
}).strict();

const editMemorySchema = z.object({
  id: z.number().int().positive(),
  project: z.string().trim().min(1).optional(),
  cause: z.string().optional(),
  lesson: z.string().optional(),
}).strict().refine(value => value.project !== undefined || value.cause !== undefined || value.lesson !== undefined, {
  message: 'At least one editable field is required',
});

const importMemorySchema = z.object({
  project: z.string().trim().min(1),
  format: z.enum(['jsonl', 'markdown']).default('jsonl'),
  data: z.string().max(5 * 1024 * 1024),
}).strict();

export class MemoryRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager,
    private defaultProject: string
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/memory/save', validateBody(saveMemorySchema), this.handleSaveMemory.bind(this));
    app.post('/api/memory/invalidate', validateBody(invalidateMemorySchema), this.handleInvalidateMemory.bind(this));
    app.post('/api/memory/edit', validateBody(editMemorySchema), this.handleEditMemory.bind(this));
    app.get('/api/memory/export', this.handleExportMemory.bind(this));
    app.post('/api/memory/import', validateBody(importMemorySchema), this.handleImportMemory.bind(this));
  }

  private handleExportMemory = this.wrapHandler((req: Request, res: Response): void => {
    if (isForeignBrowserRead(req)) {
      res.status(403).json({ error: 'Memory export from another browser page is not allowed' });
      return;
    }
    const project = typeof req.query.project === 'string' ? req.query.project.trim() : '';
    const format = req.query.format === 'markdown' ? 'markdown' : 'jsonl';
    if (!project) {
      this.badRequest(res, 'project is required');
      return;
    }
    const output = exportProjectLessons(this.dbManager.getConnection(), project, format);
    res.setHeader('Content-Type', format === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${project.replace(/[^a-zA-Z0-9._-]/g, '-')}.${format === 'markdown' ? 'md' : 'jsonl'}"`);
    res.send(output);
  });

  private handleImportMemory = this.wrapHandler((req: Request, res: Response): void => {
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'Memory changes from a different localhost origin are not allowed' });
      return;
    }
    const { project, format, data } = req.body as z.infer<typeof importMemorySchema>;
    let records;
    try { records = parsePortableLessons(data, format, project); }
    catch (error) { this.badRequest(res, error instanceof Error ? error.message : 'Invalid portable lesson data'); return; }
    const results = records.map(record => saveMemory(this.dbManager, project, portableLessonInput(record, project)));
    res.json({ success: true, imported: results.filter(result => !result.duplicate).length,
      duplicates: results.filter(result => result.duplicate).length, ids: results.map(result => result.id) });
  });

  private handleEditMemory = this.wrapHandler((req: Request, res: Response): void => {
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'Memory changes from a different localhost origin are not allowed' });
      return;
    }
    const input = req.body as z.infer<typeof editMemorySchema>;
    const db = this.dbManager.getConnection();
    const row = db.query(`SELECT id, title, narrative, project, concepts, memory_session_id, sync_rev, origin_device_id
      FROM observations WHERE id = ?`).get(input.id) as {
        id: number; title: string; narrative: string; project: string; concepts: string | null;
        memory_session_id: string; sync_rev: string; origin_device_id: string | null;
      } | null;
    if (!row) {
      this.notFound(res, `Observation #${input.id} not found`);
      return;
    }
    if (row.origin_device_id !== null) {
      res.status(409).json({ error: 'Replicated memories cannot be edited from this device' });
      return;
    }
    const fieldStart = row.narrative.search(/\n\n(?:Outcome: |Cause: |Lesson: )/);
    const body = fieldStart < 0 ? row.narrative : row.narrative.slice(0, fieldStart);
    const fields = fieldStart < 0 ? '' : row.narrative.slice(fieldStart + 2);
    const outcome = fields.match(/^Outcome:\s*(.+)$/m)?.[1];
    const cause = input.cause !== undefined ? input.cause.trim() : fields.match(/^Cause:\s*(.*)$/m)?.[1]?.trim();
    const lesson = input.lesson !== undefined ? input.lesson.trim() : fields.match(/^Lesson:\s*(.*)$/m)?.[1]?.trim();
    const lessonFields = [outcome ? `Outcome: ${outcome}` : '', cause ? `Cause: ${cause}` : '', lesson ? `Lesson: ${lesson}` : '']
      .filter(Boolean).join('\n');
    const narrative = [body, lessonFields].filter(Boolean).join('\n\n');
    let concepts: unknown[] = [];
    try { concepts = Array.isArray(JSON.parse(row.concepts ?? '[]')) ? JSON.parse(row.concepts ?? '[]') : []; } catch { concepts = []; }
    concepts = concepts.filter(concept => concept !== LESSON_CONCEPT);
    if (lesson) concepts.push(LESSON_CONCEPT);
    const project = input.project ?? row.project;
    const contentHash = computeObservationContentHash(row.memory_session_id, row.title, narrative);
    const syncRev = incrementCanonicalDecimal(row.sync_rev);
    db.transaction(() => {
      db.query(`UPDATE observations
        SET narrative = ?, project = ?, concepts = ?, content_hash = ?, sync_rev = ?, synced_at = NULL
        WHERE id = ?`).run(narrative, project, JSON.stringify(concepts), contentHash, syncRev, input.id);
      db.run('CREATE TABLE IF NOT EXISTS local_vectors (key TEXT PRIMARY KEY, model_id TEXT NOT NULL, content_hash TEXT NOT NULL, embedding BLOB NOT NULL, bit_signature BLOB)');
      db.query('DELETE FROM local_vectors WHERE key = ?').run(`observations:${input.id}`);
    })();
    this.dbManager.getCloudSync()?.notify();
    res.json({ success: true, id: input.id, project, cause: cause ?? '', lesson: lesson ?? '' });
  });

  private handleInvalidateMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'Memory changes from a different localhost origin are not allowed' });
      return;
    }
    res.json(invalidateMemory(this.dbManager.getConnection(), req.body as z.infer<typeof invalidateMemorySchema>));
  });

  private handleSaveMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    // An explicit save writes a user-visible memory observation, so other
    // localhost pages may not trigger it. Origin-less clients (the MCP
    // save_memory tool, Hermes, grok-bot) keep the existing loopback-trust model.
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'Memory saves from a different localhost origin are not allowed' });
      return;
    }
    const { cwd, ...input } = req.body as z.infer<typeof saveMemorySchema>;
    const checkout = cwd?.trim() ? cwd : undefined;
    if (checkout) {
      const excluded = process.env.CLAUDE_MEM_EXCLUDED_PROJECTS
        ?? SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH).CLAUDE_MEM_EXCLUDED_PROJECTS;
      if (isProjectExcluded(checkout, excluded)) {
        res.json({ success: false, skipped: true, reason: 'project_excluded' });
        return;
      }
      const named = input.project?.trim() || (typeof input.metadata?.project === 'string' && input.metadata.project.trim());
      if (!named) input.project = getProjectContext(checkout).primary;
      const git = getGitMemoryMetadata(checkout);
      if (git) input.metadata = { ...input.metadata, ...git };
    }
    const result = await saveMemoryChecked(this.dbManager, this.defaultProject, input);
    logger.debug('HTTP', 'Explicit memory request completed', { id: 'id' in result ? result.id : result.existingId });
    res.json(result);
  });
}
