// Who may open a cloud board and what they may do there. Emails stay on the server; boards only hold display names.
export const accessModes = ['private', 'link', 'everyone'], shareRoles = ['view', 'edit'];
const strength = { view: 1, edit: 2 };

// The owner, else the stronger of the person's invitation and the board's link or everyone setting: as in Google Docs,
// an invited viewer can still edit a board whose link lets anyone edit. `invited` is that person's own invitation, if any.
export function boardRole(board, email, invited) {
  if (!board || !email) return null;
  if (board.owner && board.owner === email) return 'owner';
  const shared = board.access === 'link' || board.access === 'everyone' ? board.linkRole : null;
  return [invited, shared].filter(role => shareRoles.includes(role)).sort((a, b) => strength[b] - strength[a])[0] || null;
}

export const canEdit = role => role === 'owner' || role === 'edit';
