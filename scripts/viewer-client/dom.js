/* global document */
export const byId = (id) => document.getElementById(id);
export function visibleText(value) {
  let result = '';
  for (const character of String(value)) {
    const point = character.codePointAt(0);
    if (
      (point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d) ||
      (point >= 0x7f && point <= 0x9f) ||
      point === 0x2028 ||
      point === 0x2029 ||
      /\p{Cf}/u.test(character)
    ) {
      result += `\\u{${point.toString(16)}}`;
    } else {
      result += character;
    }
  }
  return result;
}

export function appendText(parent, tag, text, className) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  item.textContent = visibleText(text);
  parent.append(item);
  return item;
}

export function actionButton(parent, label, action, data = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = visibleText(label);
  button.dataset.action = action;
  for (const [key, value] of Object.entries(data)) button.dataset[key] = value;
  parent.append(button);
  return button;
}

export function symbolAnchor(symbol) {
  return `${symbol.filePath}@${symbol.range.start.line}:${symbol.range.start.column}`;
}
