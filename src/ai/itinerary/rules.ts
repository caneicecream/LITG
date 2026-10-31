import { addDays, daysBetween, type IsoDate } from "@/domain/dates";
import { ATTRACTIONS, PARKS } from "@/itinerary/catalog";
import type { ItineraryInput } from "@/itinerary/types";
import { EMPTY_ITINERARY_PATCH, timesIn, type ItineraryPatch, type ItineraryProposal } from "./patch";

/**
 * Basic-mode itinerary interpreter (no API key). Understands common phrasings;
 * anything else is asked about or reported. Questions about current park facts
 * (hours, waits, crowds, availability) are answered honestly: the app has no
 * such data, and the user can enter what they know.
 */

/** Does a message ask for itinerary planning (rather than trip pricing)? */
export function isItineraryRequest(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(itinerar|day[- ]by[- ]day|park days?|(\d+|one|two|three|four|five|six|seven)[- ]day plan|plan (our|my|the) days|daily plan|which park|attractions?|rides?|lightning lane|dining reservation|walking|backtrack|crossing the park|afternoons? (flexible|free)|ride-focused|relaxed plan|demanding day|midday (break|rest))\b/.test(t);
}

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** Names people use for catalog attractions. */
const ALIASES: [RegExp, string][] = [
  [/seven dwarfs|mine train/, "mk-seven-dwarfs"],
  [/peter pan/, "mk-peter-pan"],
  [/small world/, "mk-small-world"],
  [/winnie|pooh/, "mk-pooh"],
  [/philharmagic/, "mk-philharmagic"],
  [/haunted mansion/, "mk-haunted-mansion"],
  [/pirates/, "mk-pirates"],
  [/jungle cruise/, "mk-jungle-cruise"],
  [/tiana/, "mk-tianas"],
  [/big thunder/, "mk-big-thunder"],
  [/space mountain/, "mk-space-mountain"],
  [/\btron\b/, "mk-tron"],
  [/buzz/, "mk-buzz"],
  [/spaceship earth/, "ep-spaceship-earth"],
  [/cosmic rewind|guardians/, "ep-cosmic-rewind"],
  [/test track/, "ep-test-track"],
  [/mission:? space/, "ep-mission-space"],
  [/soarin/, "ep-soarin"],
  [/living with the land/, "ep-living-land"],
  [/\bnemo\b|the seas/, "ep-seas"],
  [/journey of water/, "ep-journey-water"],
  [/frozen/, "ep-frozen"],
  [/gran fiesta/, "ep-gran-fiesta"],
  [/remy|ratatouille/, "ep-remy"],
  [/rise of the resistance/, "hs-rise"],
  [/smugglers|millennium falcon/, "hs-smugglers"],
  [/slinky/, "hs-slinky"],
  [/toy story mania/, "hs-toy-story-mania"],
  [/alien swirling|swirling saucers/, "hs-alien-saucers"],
  [/runaway railway/, "hs-runaway-railway"],
  [/tower of terror/, "hs-tower"],
  [/beauty and the beast/, "hs-beauty-beast"],
  [/star tours/, "hs-star-tours"],
  [/flight of passage/, "ak-flight-of-passage"],
  [/na'?vi river/, "ak-navi-river"],
  [/safari/, "ak-safaris"],
  [/gorilla falls/, "ak-gorilla-falls"],
  [/lion king/, "ak-lion-king"],
  [/everest/, "ak-everest"],
  [/kali river/, "ak-kali"],
  [/maharajah/, "ak-maharajah"],
  [/feathered friends/, "ak-feathered-friends"],
  [/railroad|the train\b/, "mk-railroad"],
  [/little mermaid|under the sea/, "mk-little-mermaid"],
  [/dumbo/, "mk-dumbo"],
  [/barnstormer/, "mk-barnstormer"],
  [/carrousel|carousel/, "mk-carrousel"],
  [/tea ?cups|tea party/, "mk-tea-party"],
  [/hall of presidents/, "mk-hall-presidents"],
  [/magic carpets|aladdin/, "mk-aladdin"],
  [/swiss family/, "mk-swiss-family"],
  [/tiki room/, "mk-tiki-room"],
  [/country bear/, "mk-country-bears"],
  [/peoplemover/, "mk-peoplemover"],
  [/astro orbiter/, "mk-astro-orbiter"],
  [/speedway/, "mk-speedway"],
  [/laugh floor/, "mk-laugh-floor"],
  [/fireworks/, "mk-fireworks"],
  [/parade/, "mk-parade"],
  [/figment|journey into imagination/, "ep-figment"],
  [/reflections of china/, "ep-china-film"],
  [/american adventure/, "ep-american-adventure"],
  [/canada far and wide/, "ep-canada-film"],
  [/rock ?'?n'? ?roller/, "hs-rock-coaster"],
  [/fantasmic/, "hs-fantasmic"],
  [/zootopia/, "ak-zootopia"],
  [/discovery island trails|tree of life/, "ak-discovery-trails"],
];
const PARK_ALIASES: [RegExp, string][] = [
  [/magic kingdom|\bmk\b/, "magic-kingdom"],
  [/epcot/, "epcot"],
  [/hollywood studios|\bhs\b/, "hollywood-studios"],
  [/animal kingdom|\bak\b/, "animal-kingdom"],
];

export function attractionsIn(text: string): string[] {
  const t = text.toLowerCase();
  return ALIASES.filter(([re]) => re.test(t)).map(([, id]) => id);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A trip date the user named ("Feb 3", "2027-02-03", "day 2"), resolved within the trip. */
export function dateIn(text: string, input: ItineraryInput): IsoDate | null {
  const t = text.toLowerCase();
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1]!;
  const span = daysBetween(input.context.arrival, input.context.departure);
  const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (md) {
    const month = MONTHS.indexOf(md[1]!) + 1;
    const day = Number(md[2]);
    for (let i = 0; i <= span; i++) {
      const d = addDays(input.context.arrival, i);
      if (Number(d.slice(5, 7)) === month && Number(d.slice(8, 10)) === day) return d;
    }
    return null;
  }
  const dayN = t.match(/\bday (\d{1,2})\b/);
  if (dayN && Number(dayN[1]) >= 1 && Number(dayN[1]) - 1 <= span) return addDays(input.context.arrival, Number(dayN[1]) - 1);
  return null;
}

export function interpretItineraryWithRules(message: string, input: ItineraryInput): ItineraryProposal {
  const text = message.trim();
  const t = text.toLowerCase();
  const patch: ItineraryPatch = structuredClone(EMPTY_ITINERARY_PATCH);
  const evidence: ItineraryProposal["evidence"] = [];
  const clarifications: string[] = [];
  const unsupported: string[] = [];
  const comparisons: ItineraryProposal["comparisons"] = [];
  const understood: string[] = [];
  const note = (field: string, quote: string, what: string) => {
    evidence.push({ field, userQuote: quote });
    understood.push(what);
  };
  let m: RegExpMatchArray | null;

  // Questions about current facts the app doesn't have.
  if (/\b(what are|what're|when (does|do)|are the|park hours|opening hours|how long (is|are) the (wait|line)|wait times?|how busy|crowd(s| levels?)?|is .+ (open|closed)|available|availability)\b/.test(t) && /\?$|^(what|when|how|is|are)\b/.test(t)) {
    unsupported.push(
      "I don't have live park information: no official hours, closures, wait times, crowd levels, or reservation and Lightning Lane availability. If you know them (for example from the official park calendar), add them under “What you already know” in the itinerary planner (park hours can be pasted for several days at once from the official calendar). Otherwise I plan provisionally with your planning window and a wait buffer, and say so.",
    );
  }

  // Comparisons.
  const wantsCompare = /\bcompare\b|\bversus\b|\bvs\.?\b/.test(t);
  if (wantsCompare && /ride[- ]focused|ride[- ]heavy|packed|as much as possible/.test(t) && /relax/.test(t)) {
    comparisons.push({ label: "Ride-focused", patch: { ...structuredClone(EMPTY_ITINERARY_PATCH), pace: "packed", maximizeAttractions: true, relaxedSchedule: false, middayBreak: false, flexibleAfternoons: false } });
    comparisons.push({ label: "Relaxed", patch: { ...structuredClone(EMPTY_ITINERARY_PATCH), pace: "relaxed", relaxedSchedule: true, middayBreak: true, minimizeWalking: true } });
    understood.push("a ride-focused plan and a relaxed plan side by side");
  }
  if ((m = t.match(/\b(remov(?:e|ed|ing)|drop(?:ped)?|lose|without|skip(?:ped)?|cut) (one|a|this|1) (park )?day\b/))) {
    const current = input.prefs.maxParkDays ?? input.context.ticket?.days ?? 0;
    if (current > 1) {
      comparisons.push({ label: `${current - 1} park days instead of ${current}`, patch: { ...structuredClone(EMPTY_ITINERARY_PATCH), parkDays: current - 1 } });
      understood.push("what changes with one fewer park day");
      evidence.push({ field: "comparison", userQuote: m[0] });
    } else unsupported.push("The plan has only one park day, so there is no day to remove.");
  }

  if (!wantsCompare) {
    // Pace and priorities.
    if (/\brelax(ed|ing)?\b|\blaid[- ]back\b|\bslow(er)? pace\b|\bnot rushed\b/.test(t)) {
      patch.pace = "relaxed";
      patch.relaxedSchedule = true;
      note("pace", "relaxed", "a relaxed pace");
    } else if (/\bride[- ]focused\b|\bpacked\b|\bas much as possible\b|\bmaxim(ize|ise) (rides|attractions)\b|\bdo everything\b/.test(t)) {
      patch.pace = "packed";
      patch.maximizeAttractions = true;
      note("pace", "ride-focused", "a packed, ride-focused plan");
    }
    if (/\b(minimi[sz]e|less|reduce|limit|not much) walking\b|\bwalk less\b/.test(t)) {
      patch.minimizeWalking = true;
      note("minimizeWalking", "minimize walking", "less walking");
    }
    if (/\bbacktrack|\bcrossing the park\b|\bcross the park\b|\bzig[- ]?zag/.test(t)) {
      patch.reduceBacktracking = true;
      note("reduceBacktracking", "avoid crossing the park", "no crossing the park repeatedly");
    }
    if (/\bafternoons? (flexible|free|open|unscheduled)|\bflexible afternoons?\b|\bfree afternoons?\b/.test(t)) {
      patch.flexibleAfternoons = true;
      note("flexibleAfternoons", "flexible afternoons", "2–4 pm kept free");
    }
    if (/\bmidday (break|rest|nap)\b|\bnap\b|\bbreak in the middle\b|\brest in the afternoon\b/.test(t)) {
      patch.middayBreak = true;
      note("middayBreak", "midday break", "a midday rest");
    }
    if (/demanding|busiest|hardest|most intense/.test(t) && /(arrival|first) day|away from|not first|later/.test(t)) {
      patch.avoidDemandingArrivalDay = true;
      note("avoidDemandingArrivalDay", "most demanding day away from arrival", "the most demanding day not first");
    }
    if (/\brest day\b|\bday off\b|\bpool day\b/.test(t)) {
      patch.restDay = /\bno rest day\b|\bwithout a rest day\b/.test(t) ? "avoid" : "prefer";
      note("restDay", "rest day", patch.restDay === "prefer" ? "a rest day" : "no rest day");
    }
    if (/\bpark ?hop/.test(t)) {
      patch.allowHopping = !/\bno park ?hop|\bwithout park ?hop|\bdon'?t park ?hop/.test(t);
      note("allowHopping", "park hopping", patch.allowHopping ? "park hopping allowed" : "no park hopping");
    }
    if ((m = t.match(/\b(\d+|one|two|three|four|five|six|seven)[- ]day (plan|itinerary|trip)\b/))) {
      const nDays = WORD_NUM[m[1]!] ?? Number(m[1]);
      patch.parkDays = nDays;
      note("parkDays", m[0], `${nDays} park days`);
    }
  }

  // Parks
  const parks = PARK_ALIASES.filter(([re]) => re.test(t)).map(([, id]) => id);
  if (parks.length && /\b(only|just)\b/.test(t) && !/\bdining|reservation|lightning\b/.test(t)) {
    patch.parks = parks;
    note("parks", parks.join(", "), `only ${parks.length === 1 ? "this park" : "these parks"}`);
  }

  // Attraction preferences, clause by clause.
  const lightning = /lightning lane/.test(t);
  if (!lightning) {
    for (const clause of t.split(/[.;!?]|,| but /)) {
      const ids = attractionsIn(clause);
      if (!ids.length) continue;
      const pref = /\b(skip|avoid|no|not|don'?t|without|scary|hate)\b/.test(clause)
        ? "avoid"
        : /\bmust|have to|need to|definitely|top priority|can'?t miss|most\b/.test(clause)
          ? "must"
          : /\b(like|want|love|would|maybe|if (there'?s|we have) time|nice)\b/.test(clause)
            ? "want"
            : null;
      if (!pref) {
        clarifications.push(`Should ${ids.map((id) => ATTRACTIONS.find((a) => a.id === id)!.name).join(" and ")} be a must-do, a “would like”, or skipped?`);
        continue;
      }
      patch.attractions = [...(patch.attractions ?? []), ...ids.map((attractionId) => ({ attractionId, preference: pref as "must" | "want" | "avoid" }))];
      note("attractions", clause.trim(), `${ids.map((id) => ATTRACTIONS.find((a) => a.id === id)!.name).join(", ")}: ${pref === "must" ? "must-do" : pref === "want" ? "would like" : "skip"}`);
    }
  }
  if (/\b(attractions|rides|things) that matter( most)?\b|\bprioriti[sz]e\b/.test(t) && !patch.attractions?.length) {
    const musts = Object.values(input.prefs.attractions).filter((v) => v === "must").length;
    if (musts) {
      patch.maximizeAttractions = false;
      understood.push("your must-dos first (extras only if there's time)");
    } else clarifications.push("Which attractions matter most? For example: “Seven Dwarfs and Remy are must-dos, skip TRON.”");
  }

  // Reservations the user states.
  if (/\b(dining|dinner|lunch|breakfast|brunch|meal)\b/.test(t) && /\b(reservation|booked|booking|adr)\b/.test(t)) {
    const time = timesIn(text)[0];
    const date = dateIn(text, input);
    const park = PARK_ALIASES.find(([re]) => re.test(t))?.[1] ?? null;
    if (!time || !date) clarifications.push("What date and time is the dining reservation (and in which park, if any)? For example: “dinner reservation at 6:30 pm on Feb 3 at EPCOT”.");
    else {
      const meal = (t.match(/\b(breakfast|brunch|lunch|dinner)\b/)?.[1] ?? "dining").replace(/^./, (c) => c.toUpperCase());
      patch.addDining = [{ date, time, parkId: park, name: `${meal} reservation`, durationMinutes: null }];
      note("addDining", text, `a ${meal.toLowerCase()} reservation at ${time} on ${date}`);
    }
  }
  if (lightning) {
    const ids = attractionsIn(t);
    const times = timesIn(text);
    const date = dateIn(text, input);
    if (/\b(available|availability|can (we|i) get|book)\b/.test(t)) {
      unsupported.push("I can't check or book Lightning Lane availability. If you already hold a return window, tell me the attraction, date and time window and I'll plan around it.");
    } else if (ids.length !== 1 || times.length < 2 || !date) {
      clarifications.push("Which attraction, date and return window? For example: “Lightning Lane for Slinky Dog Dash on Feb 4 from 10:00 to 11:00”.");
    } else {
      patch.addLightningLane = [{ date, attractionId: ids[0]!, start: times[0]!, end: times[1]! }];
      note("addLightningLane", text, "a Lightning Lane return window you hold");
    }
  }

  const changed = Object.values(patch).some((v) => v !== null) || comparisons.length > 0;
  const plan = /\b(build|make|create|plan|give me|show)\b/.test(t) || /\bwhat would we lose\b/.test(t);
  const intent: ItineraryProposal["intent"] = changed ? "update" : clarifications.length ? "clarify" : unsupported.length ? "unsupported" : plan || /\?$/.test(text) ? "explain" : "chat";
  const reply = changed
    ? `I understood: ${understood.join("; ")}.`
    : intent === "explain"
      ? "Here's what the itinerary planner produced."
      : intent === "chat"
        ? "For itineraries, basic mode understands things like “build a relaxed plan”, “minimize walking”, “keep our afternoons flexible”, “Seven Dwarfs is a must-do, skip TRON”, “dinner reservation at 6:30 pm on Feb 3 at EPCOT”, “compare a ride-focused plan with a relaxed plan”, or “what would we lose if we removed a park day?”."
        : "";
  return { intent, reply, patch, evidence, comparisons, clarifications, unsupported };
}

export const PARK_IDS = PARKS.map((p) => p.id);
