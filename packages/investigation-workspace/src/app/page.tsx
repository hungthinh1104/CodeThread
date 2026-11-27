import type { AiStatusResponse } from '@codethread/contracts';
import { InvestigationWorkspace } from '../features/investigation/InvestigationWorkspace.tsx';
import {
  systemHealth,
  type BackendHealthStatus,
} from '../server/scan-admin-bff.ts';
import { aiStatus } from '../server/workspace-bff.ts';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const probed = await systemHealth().catch(async () => ({
    health: null as BackendHealthStatus | null,
    ai: await aiStatus().catch((): AiStatusResponse => ({
      enabled: false,
    })),
  }));
  return (
    <InvestigationWorkspace
      initialAiStatus={probed.ai}
      initialHealth={probed.health}
    />
  );
}
