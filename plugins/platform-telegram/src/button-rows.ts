interface Button {
  label: string;
}

function buttonsPerRow(label: string) {
  const length = [...label].length;
  if (length <= 8) return 4;
  if (length <= 14) return 3;
  if (length <= 22) return 2;
  return 1;
}

export function buttonRows<T extends Button>(
  buttons: readonly T[],
  approval = false,
): T[][] {
  const rows: T[][] = [];
  let row: T[] = [];
  let limit = 4;
  for (const button of buttons) {
    const capacity = approval ? 4 : buttonsPerRow(button.label);
    if (row.length >= Math.min(limit, capacity)) {
      rows.push(row);
      row = [];
      limit = 4;
    }
    limit = Math.min(limit, capacity);
    row.push(button);
  }
  if (row.length) rows.push(row);
  return rows;
}
