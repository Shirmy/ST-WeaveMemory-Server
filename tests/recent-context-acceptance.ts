import assert from 'node:assert/strict';
import { buildRecentContext, extractSummary } from '../src/state/recent-context';

async function main(): Promise<void> {
  assert.equal(extractSummary('正文\n[摘要]事件已完成[/摘要]', '\\[摘要\\]([\\s\\S]*?)\\[/摘要\\]'), '事件已完成');
  assert.equal(extractSummary('没有摘要标记', '\\[摘要\\]([\\s\\S]*?)\\[/摘要\\]'), null);
  assert.equal(extractSummary('坏正则', '['), null);
  const items = buildRecentContext([
    { floorId: 'f1', messageIndex: 1, content: '[摘要]第一楼[/摘要]' },
    { floorId: 'f2', messageIndex: 2, content: '第二楼无摘要' },
    { floorId: 'f3', messageIndex: 3, content: '[摘要]第三楼[/摘要]' }
  ], { mode: 'summary', summaryRegex: '\\[摘要\\]([\\s\\S]*?)\\[/摘要\\]', recentFloorCount: 2 });
  assert.deepEqual(items.map(item => item.text), ['第二楼无摘要', '第三楼']);
  assert.deepEqual(items.map(item => item.source), ['fallback', 'summary']);
  const raw = buildRecentContext([{ floorId: 'f1', messageIndex: 1, content: '[摘要]保留原文[/摘要]' }]);
  assert.equal(raw[0].text, '[摘要]保留原文[/摘要]');
  console.log('recent context acceptance passed');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
