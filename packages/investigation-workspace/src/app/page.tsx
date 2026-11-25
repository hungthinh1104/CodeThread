import type { AiStatusResponse } from '@codethread/contracts';
import { InvestigationWorkspace } from '../features/investigation/InvestigationWorkspace.tsx';
import { aiStatus } from '../server/workspace-bff.ts';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const initialAiStatus: AiStatusResponse = await aiStatus().catch(() => ({
    enabled: false,
  }));
  return <InvestigationWorkspace initialAiStatus={initialAiStatus} />;
}
