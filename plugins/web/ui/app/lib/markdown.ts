import { marked, Renderer } from 'marked';

function escape(text: string) {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

const renderer = new Renderer();
renderer.html = ({ text }) => escape(text);
renderer.image = ({ text }) => escape(text);
renderer.link = function ({ href, tokens }) {
  const label = this.parser.parseInline(tokens);
  // Explicit protocol allowlist prevents executable and obfuscated schemes.
  if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) return label;
  return (
    '<a href="' +
    escape(href) +
    '" target="_blank" rel="noopener noreferrer">' +
    label +
    '</a>'
  );
};

export function renderMarkdown(text: string) {
  return marked.parse(text, { async: false, renderer });
}
