export interface EditorSnapshot {
  documentId: string;
}

export function restoreState(snapshot: EditorSnapshot): EditorSnapshot {
  return { documentId: snapshot.documentId };
}
