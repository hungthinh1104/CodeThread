import { ScanDetailScreen } from '../../../features/scans/ScanDetailScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function ScanDetailPage({
  params,
}: {
  params: Promise<{ scanId: string }>;
}) {
  const { scanId } = await params;
  return <ScanDetailScreen scanId={scanId} />;
}
