import { describe, expect, it } from 'vitest';
import { renderSvgOverlay } from './render-svg.ts';

describe('renderSvgOverlay', () => {
  it('renders an SVG document sized to the source image', () => {
    const svg = renderSvgOverlay({
      spec: { shapes: [{ type: 'rect', x: 0, y: 0, width: 10, height: 10 }] },
      width: 640,
      height: 480,
    });
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain('width="640"');
    expect(svg).toContain('height="480"');
    expect(svg).toContain('viewBox="0 0 640 480"');
  });

  it('renders a rect with the default red stroke when no color is given', () => {
    const svg = renderSvgOverlay({
      spec: { shapes: [{ type: 'rect', x: 5, y: 6, width: 10, height: 20 }] },
      width: 100,
      height: 100,
    });
    expect(svg).toContain('<rect x="5" y="6" width="10" height="20"');
    expect(svg).toContain('stroke="#ef4444"');
    expect(svg).toContain('fill="none"');
  });

  it('honours an explicit color and strokeWidth on a rect', () => {
    const svg = renderSvgOverlay({
      spec: { shapes: [{ type: 'rect', x: 0, y: 0, width: 1, height: 1, color: '#00ff00', strokeWidth: 8 }] },
      width: 10,
      height: 10,
    });
    expect(svg).toContain('stroke="#00ff00"');
    expect(svg).toContain('stroke-width="8"');
  });

  it('escapes XML-special characters in colour and text', () => {
    const svg = renderSvgOverlay({
      spec: { shapes: [{ type: 'text', x: 0, y: 0, text: '<script>alert("x")</script>' }] },
      width: 100,
      height: 100,
    });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&quot;x&quot;');
  });

  it('renders an arrow as line + filled polygon head', () => {
    const svg = renderSvgOverlay({
      spec: { shapes: [{ type: 'arrow', x1: 10, y1: 10, x2: 50, y2: 10 }] },
      width: 100,
      height: 100,
    });
    expect(svg).toContain('<line x1="10" y1="10" x2="50" y2="10"');
    expect(svg).toContain('<polygon points="50,10');
    expect(svg).toContain('fill="#ef4444"');
  });

  it('renders text with a background pill when background is set', () => {
    const svg = renderSvgOverlay({
      spec: { shapes: [{ type: 'text', x: 10, y: 20, text: 'p99', background: '#fff' }] },
      width: 100,
      height: 100,
    });
    expect(svg).toContain('fill="#fff"');
    expect(svg).toContain('>p99<');
  });

  it('renders text without a background pill by default', () => {
    const svg = renderSvgOverlay({
      spec: { shapes: [{ type: 'text', x: 10, y: 20, text: 'plain' }] },
      width: 100,
      height: 100,
    });
    // No background <rect> before the text element.
    expect(svg.match(/<rect[^/]+rx=/)).toBeNull();
    expect(svg).toContain('>plain<');
  });

  it('concatenates multiple shapes inside one svg element', () => {
    const svg = renderSvgOverlay({
      spec: {
        shapes: [
          { type: 'rect', x: 0, y: 0, width: 10, height: 10 },
          { type: 'arrow', x1: 5, y1: 5, x2: 20, y2: 20 },
          { type: 'text', x: 30, y: 30, text: 'A' },
        ],
      },
      width: 100,
      height: 100,
    });
    expect(svg.match(/<svg /g)).toHaveLength(1);
    expect(svg.match(/<\/svg>/g)).toHaveLength(1);
    expect(svg.match(/<rect /g)?.length).toBeGreaterThanOrEqual(1);
    expect(svg.match(/<line /g)?.length).toBe(1);
    expect(svg.match(/<polygon /g)?.length).toBe(1);
    expect(svg.match(/<text /g)?.length).toBe(1);
  });
});
