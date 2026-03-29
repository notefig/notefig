"use client";

import { TrailingBlockPlugin } from "platejs";

import { AutoformatKit } from "@/components/editor/plugins/autoformat-kit";
import { BasicBlocksKit } from "@/components/editor/plugins/basic-blocks-kit";
import { BasicMarksKit } from "@/components/editor/plugins/basic-marks-kit";
import { CodeBlockKit } from "@/components/editor/plugins/code-block-kit";
import { TableKit } from "@/components/editor/plugins/table-kit";
import { CommentKit } from "@/components/editor/plugins/comment-kit";
import { DiscussionKit } from "@/components/editor/plugins/discussion-kit";
import { BlockSelectionKit } from "@/components/editor/plugins/block-selection-kit";
import { DndKit } from "@/components/editor/plugins/dnd-kit";
import { ExitBreakKit } from "@/components/editor/plugins/exit-break-kit";
import { LinkKit } from "@/components/editor/plugins/link-kit";
import { ListKit } from "@/components/editor/plugins/list-kit";
import { MarkdownKit } from "@/components/editor/plugins/markdown-kit";
import { MediaKit } from "@/components/editor/plugins/media-kit";
import { SuggestionKit } from "@/components/editor/plugins/suggestion-kit";

// Minimal editor kit focused on markdown compatibility
export const MarkdownEditorKit = [
  // Core Elements
  ...BasicBlocksKit, // Headings, paragraphs, blockquotes, HR
  ...CodeBlockKit, // Code blocks with syntax highlighting
  ...TableKit, // Tables with cell merging, resizing, and row/column manipulation
  ...LinkKit, // Links with auto-linking
  ...ListKit, // Bullet and numbered lists

  // Marks (bold, italic, underline, strikethrough, code, highlight, kbd)
  ...BasicMarksKit,

  // Collaboration (needed for LinkElement and BlockDiscussion to work correctly)
  ...DiscussionKit, // Discussion and user data
  ...CommentKit, // Comments on text
  ...SuggestionKit, // Track changes and suggestions

  // Editing
  ...AutoformatKit, // Markdown shortcuts like **bold**, * lists, # headings
  ...ExitBreakKit, // Better enter key behavior
  TrailingBlockPlugin, // Always have a trailing paragraph

  // Block selection (required by DnD for multi-block selection and drag preview)
  ...BlockSelectionKit,

  // Drag and drop for blocks
  ...DndKit,

  // Markdown serialization
  ...MarkdownKit,

  // Media support (images, video, audio, files)
  ...MediaKit,
];
