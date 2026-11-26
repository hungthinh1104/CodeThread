import { useEffect, useRef, useState } from 'react';
import { readViewer } from '../api.ts';
import { errorMessage } from '../queries.ts';
import type { FilePage, WorkspaceMetadata } from '../types.ts';

export function useFileInventory(workspace: WorkspaceMetadata | null) {
  const [files, setFiles] = useState<FilePage | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<{
    offset: number;
    message: string;
  } | null>(null);
  const fileGeneration = useRef(0);

  function invalidateFiles() {
    ++fileGeneration.current;
  }

  function resetFiles() {
    ++fileGeneration.current;
    setFiles(null);
    setFilesLoading(false);
    setFilesError(null);
  }

  async function chooseFilesPage(offset: number) {
    if (!workspace) return;
    const generation = ++fileGeneration.current;
    setFilesLoading(true);
    setFilesError(null);
    try {
      const page = await readViewer<FilePage>(workspace.scanId, 'files', {
        offset,
      });
      if (generation === fileGeneration.current) {
        setFiles(page);
        setFilesError(null);
      }
    } catch (error) {
      if (generation === fileGeneration.current)
        setFilesError({ offset, message: errorMessage(error) });
    } finally {
      if (generation === fileGeneration.current) setFilesLoading(false);
    }
  }

  function retryFiles() {
    if (filesError) void chooseFilesPage(filesError.offset);
  }

  useEffect(() => {
    if (!workspace) return;
    const generation = ++fileGeneration.current;
    const workspaceId = workspace.scanId;
    setFilesLoading(true);
    setFilesError(null);
    void readViewer<FilePage>(workspaceId, 'files', { offset: 0 })
      .then((page) => {
        if (
          generation === fileGeneration.current &&
          workspaceId === workspace.scanId
        )
          setFiles(page);
      })
      .catch((error: unknown) => {
        if (generation === fileGeneration.current)
          setFilesError({ offset: 0, message: errorMessage(error) });
      })
      .finally(() => {
        if (generation === fileGeneration.current) setFilesLoading(false);
      });
  }, [workspace?.scanId]);

  useEffect(() => {
    return () => {
      ++fileGeneration.current;
    };
  }, []);

  return {
    files,
    filesLoading,
    filesError,
    invalidateFiles,
    resetFiles,
    chooseFilesPage,
    retryFiles,
  };
}
