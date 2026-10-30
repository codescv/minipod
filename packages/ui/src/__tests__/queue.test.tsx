import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderMiniPod } from './test-helpers';

describe('Unified Queue Reorder, Remove + Undo & Clear', () => {
  it('shows total remaining duration header, reorders via drag-and-drop & menu, removes with Undo, and clears queue', async () => {
    const { host } = renderMiniPod({ width: 1024 });

    await screen.findByText('Syntax & Signal');
    fireEvent.click(screen.getByTestId('nav-rail-queue'));

    expect(await screen.findByTestId('queue-screen')).toBeInTheDocument();
    expect(await screen.findByTestId('queue-header-title')).toHaveTextContent(/Queue · 3 episodes ·/);

    const initialQueue = await host.queue.list();
    expect(initialQueue).toHaveLength(3);
    const firstKey = initialQueue[0]!.episode.episodeKey;
    const thirdKey = initialQueue[2]!.episode.episodeKey;

    // Move 3rd item to top via row menu
    fireEvent.click(screen.getByTestId(`queue-menu-${thirdKey}`));
    fireEvent.click(screen.getByTestId(`queue-move-top-${thirdKey}`));

    await waitFor(async () => {
      const reordered = await host.queue.list();
      expect(reordered[0]?.episode.episodeKey).toBe(thirdKey);
    });

    // Reorder via HTML5 drag-and-drop (drag index 0 onto index 2)
    const row0 = screen.getByTestId('queue-row-0');
    const row2 = screen.getByTestId('queue-row-2');
    const dataStore = new Map<string, string>();
    const mockDataTransfer = {
      effectAllowed: 'move',
      setData: (k: string, v: string) => dataStore.set(k, v),
      getData: (k: string) => dataStore.get(k) ?? '',
    };
    fireEvent.dragStart(row0, { dataTransfer: mockDataTransfer });
    fireEvent.dragOver(row2, { dataTransfer: mockDataTransfer });
    fireEvent.drop(row2, { dataTransfer: mockDataTransfer });

    await waitFor(async () => {
      const reordered = await host.queue.list();
      expect(reordered[2]?.episode.episodeKey).toBe(thirdKey);
      expect(reordered[0]?.episode.episodeKey).toBe(firstKey);
    });

    // Remove middle item (index 1) and Undo to restore it in-place
    const midItem = (await host.queue.list())[1]!;
    fireEvent.click(screen.getByTestId(`queue-menu-${midItem.episode.episodeKey}`));
    fireEvent.click(screen.getByTestId(`queue-remove-${midItem.episode.episodeKey}`));

    await waitFor(async () => {
      expect(await host.queue.list()).toHaveLength(2);
    });
    expect(await screen.findByTestId('snackbar')).toHaveTextContent(/Removed/);

    fireEvent.click(screen.getByTestId('snackbar-action'));
    await waitFor(async () => {
      const restored = await host.queue.list();
      expect(restored).toHaveLength(3);
      expect(restored[1]?.episode.episodeKey).toBe(midItem.episode.episodeKey);
    });

    // Clear queue
    fireEvent.click(screen.getByTestId('queue-overflow-btn'));
    fireEvent.click(screen.getByTestId('queue-clear-btn'));
    expect(await screen.findByTestId('queue-empty')).toBeInTheDocument();
  });
});
