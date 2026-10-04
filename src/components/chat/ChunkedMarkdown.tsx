import { memo, useMemo } from 'react';
import { View } from 'react-native';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { splitMarkdownBlocks } from './markdownBlocks';

/**
 * Renders markdown as a list of top-level blocks, each through the memo'd
 * MarkdownRenderer. While a reply streams, settled blocks keep the same string
 * (and the same index key), so only the block being written is re-parsed on
 * each flush. Used for finished messages too, so nothing re-mounts or reflows
 * when a stream ends.
 */
export const ChunkedMarkdown = memo(function ChunkedMarkdown({
  content,
  tone,
}: {
  content: string;
  tone?: 'default' | 'muted';
}) {
  const blocks = useMemo(() => {
    const { settled, tail } = splitMarkdownBlocks(content);
    return tail.trim() ? [...settled, tail] : settled;
  }, [content]);

  return (
    <View>
      {blocks.map((block, i) => (
        // Index keys are intended: block i only ever grows into its settled form.
        <MarkdownRenderer key={i} content={block} tone={tone} />
      ))}
    </View>
  );
});
