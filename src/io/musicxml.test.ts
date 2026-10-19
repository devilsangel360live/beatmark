import { describe, expect, it } from "vitest";
import { createDemoProject } from "../core/project";
import { beamGroupTicks, beamsFor, exportMusicXml } from "./musicxml";

describe("exportMusicXml", () => {
  it("writes each measure with hands and feet voices that both fill the bar", () => {
    const { xml, warnings } = exportMusicXml(createDemoProject());
    expect(xml.match(/<measure /g)).toHaveLength(4);
    expect(xml).toContain("<sign>percussion</sign>");

    const first = xml.slice(xml.indexOf('<measure number="1">'), xml.indexOf('<measure number="2">'));
    const [hands, feet] = first.split("<backup>");
    const total = (s: string) => [...s.matchAll(/<note>.*?<duration>(\d+)<\/duration>/g)]
      .filter((m) => !m[0].includes("<chord/>"))
      .reduce((sum, m) => sum + Number(m[1]), 0);
    expect(total(hands)).toBe(1920);
    expect(total(feet.slice(feet.indexOf("</backup>")))).toBe(1920);
    expect(warnings).toEqual([]);
  });

  it("marks hi-hats with x noteheads and kicks with stems down", () => {
    const { xml } = exportMusicXml(createDemoProject());
    expect(xml).toMatch(/<display-step>G<\/display-step><display-octave>5<\/display-octave>.*?<notehead>x<\/notehead>/);
    expect(xml).toMatch(/<display-step>F<\/display-step><display-octave>4<\/display-octave>.*?<stem>down<\/stem>/);
  });

  it("beams eighths in pairs per beat and 16ths with a second beam level", () => {
    const eighth = { value: "8", dots: 0 } as const;
    const sixteenth = { value: "16", dots: 0 } as const;
    const chord = [{ id: "x", offset: 0, duration: eighth, instrument: "snare" as const, articulations: [] }];
    // Beat 1: two 8ths. Beat 2: 8th + two 16ths. Then a rest breaks the run before a lone 8th.
    const items = [
      { offset: 0, duration: eighth, chord },
      { offset: 240, duration: eighth, chord },
      { offset: 480, duration: eighth, chord },
      { offset: 720, duration: sixteenth, chord },
      { offset: 840, duration: sixteenth, chord },
      { offset: 960, duration: eighth },
      { offset: 1200, duration: eighth, chord },
    ];
    expect(beamsFor(items, beamGroupTicks({ beats: 4, beatUnit: 4 }))).toEqual([
      ["1:begin"],
      ["1:end"],
      ["1:begin"],
      ["1:continue", "2:begin"],
      ["1:end", "2:end"],
      [],
      [],
    ]);
  });

  it("writes beams into the exported notes", () => {
    const { xml } = exportMusicXml(createDemoProject());
    expect(xml).toContain('<beam number="1">begin</beam>');
    expect(xml).toContain('<beam number="1">end</beam>');
  });

  it("warns about unresolved notes instead of exporting them silently", () => {
    const p = createDemoProject();
    p.score.measures[0].events[0].unresolved = true;
    expect(exportMusicXml(p).warnings[0]).toMatch(/1 note\(s\) still marked for review/);
  });
});
