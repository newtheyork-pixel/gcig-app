import Foundation

// The banner call sheets, in the app rather than in a PDF beside it.
//
// Thomas wrote five of these, one per banner, and they are not variations
// on a theme: Banter sells no bridal so it carries no engagement-ring
// question at all, Jared's anchors are four and eight thousand dollars
// where Banter's is a hundred and fifty, and the Kay Outlet sheet exists
// to be asked at the outlet AND its paired mainline store on the same
// afternoon because the finding is the difference between the two.
//
// Getting the wrong sheet in front of somebody mid-call is therefore not
// a formatting problem, it is a wasted door. Hence keyed on the banner
// the queue already carries, with the outlet matched before the mainline
// because "Kay Outlet" contains "Kay".
//
// The sheets say SAY IT EXACTLY LIKE THIS, so the openers are verbatim.
// One sentence is appended to each, and it is the recording disclosure:
// the sheets were written for a process that took notes and did not
// record, and this app records. Reading the sheet's opener as written,
// while a recorder runs, would remove the thing that makes the recording
// lawful at both ends.
struct CallScript {
    let banner: String
    /// The sheet's own framing note, which is usually a warning.
    let note: String
    let opener: String
    let questions: [Question]
    let followUps: String
    let doNotAsk: String

    struct Question {
        let text: String
        let why: String
    }

    /// The sentence the sheets do not have, because they predate the
    /// recorder. Appended to every opener rather than shown separately:
    /// a disclosure in a different box is a disclosure people skip.
    static let recordingLine =
        "I'm recording this so I get the details right. Is that OK?"

    static func forBanner(_ tier: String?) -> CallScript? {
        guard let t = tier?.trimmingCharacters(in: .whitespaces).uppercased(), !t.isEmpty
        else { return nil }
        // Outlet before mainline. "Kay Outlet" contains "Kay", and the
        // wrong sheet here costs the whole call.
        if t.contains("OUTLET") { return kayOutlet }
        if t.contains("BANTER") || t.contains("PAGODA") { return banter }
        if t.contains("JARED") { return jared }
        if t.contains("ZALES") { return zales }
        if t.contains("KAY") { return kay }
        return nil
    }

    // MARK: The sheets

    static let kay = CallScript(
        banner: "Kay",
        note: "Seven questions. Ask 2 and 3 separately — asked together on 10 Sep they produced a self-contradictory answer.",
        opener: "Hi, my name is [name]. I'm a high school student at Grace Church School in New York and I'm doing a research project on the jewellery business for our school investment club. Do you have two minutes for a few questions about what's in the store? It's nothing confidential, just what's on the shelf.",
        questions: [
            .init(text: "What is the least expensive gold chain you have in the case right now, and what does it cost?",
                  why: "The anchor. Checkable afterwards against our own catalogue census of 174,038 products."),
            .init(text: "Six months ago, would that cheapest chain have been cheaper?",
                  why: "THE ONE THAT MATTERS. Has the floor price moved up?"),
            .init(text: "Do you still carry the lighter weight chains, or have those gone?",
                  why: "The other half. Has the cheap end left the case?"),
            .init(text: "Is there a promotion running right now? What is it?",
                  why: "In-store posture against the online posture the census already tracks."),
            .init(text: "If someone came in wanting an engagement ring around twelve hundred dollars, what would you show them?",
                  why: "What the middle of the bridal ladder actually looks like on the floor."),
            .init(text: "At that price, would that be lab-grown or natural? Which do people usually go with?",
                  why: "The mix question nobody will quantify. No lab-grown number has ever appeared in a filing or on a call."),
            .init(text: "If they give you a share: is that most of what you sell, or most of what is in the case?",
                  why: "PIN THE BASIS. A store said about 70% lab-grown and it is unusable because nobody knows what it is 70% of."),
        ],
        followUps: "ONE FOLLOW-UP PER ANSWER. If they name a price, ask what it was before. If they say the light chains are gone, ask when. Once per answer, then move on. Not doing this is the measured weakness in our own call record, and it is where the value is.",
        doNotAsk: "No sales, no traffic, no targets, no comparison to last year. If they start volunteering it, steer back to the case."
    )

    static let zales = CallScript(
        banner: "Zales",
        note: "Ask these exact words at the Kay in the same shopping centre on the same afternoon.",
        opener: "Hi, is this Zales? … My name is [name]. I'm a high school student at Grace Church School in New York and I'm doing a research project on the jewellery business for our school investment club. Do you have two minutes for a few questions about what's in the store? It's nothing confidential, just what's on the shelf.",
        questions: [
            .init(text: "What's the least expensive gold chain you have in the case right now, and what does it cost?", why: ""),
            .init(text: "If somebody came in with about five thousand dollars to spend, what would you show them?", why: ""),
            .init(text: "If someone came in wanting an engagement ring around twelve hundred dollars, what would you show them?",
                  why: "Stop there. Do not attach \"lab or natural\" to it."),
            .init(text: "When you're down to the last couple of something and it's not selling, what happens to it?",
                  why: "Open form. Do not suggest where it goes. Wait for them to say."),
            .init(text: "If somebody brings in a ring that needs to be resized, do you do that in the store or does it get sent out?", why: ""),
        ],
        followUps: "TWO FOR THE WHOLE CALL, NOT TWO PER QUESTION. After 3, only if they name a ring: \"About what size stone is that?\" After 5, only if they say in store: \"About how long does that take?\"",
        doNotAsk: "Do not ask them to compare Zales to Kay as a business. You may ask where they send someone for something they do not carry."
    )

    static let jared = CallScript(
        banner: "Jared",
        note: "Top of the ladder. The anchors here are four and eight thousand dollars.",
        opener: "Hi, is this Jared? … My name is [name]. I'm a high school student at Grace Church School in New York and I'm doing a research project on the jewellery business for our school investment club. Do you have two minutes for a few questions about what's in the store?",
        questions: [
            .init(text: "If someone came in with about four thousand dollars for an engagement ring, what would you show them?",
                  why: "Open form. Do not force a choice. \"Both\" is an answer and it is data."),
            .init(text: "And if that same person told you they only wanted a natural diamond, what would four thousand get them?", why: ""),
            .init(text: "And if someone came in with around eight thousand, what would you show them?",
                  why: "No \"still\", no \"do they go natural\". Those give away the answer."),
            .init(text: "If I brought a ring in today to get resized, when would I get it back?", why: ""),
            .init(text: "When you stop carrying something, what happens to the ones that are left?",
                  why: "Say nothing after it. Wait."),
        ],
        followUps: "TWO FOR THE WHOLE CALL. After 1 or 3, once: \"Is that one lab or natural?\" After 5, only if they volunteer that stock leaves the store: \"Where does it go?\"",
        doNotAsk: "Cheapest gold chain. Anything at a $150 price point. That is a Banter question and it wastes the call here."
    )

    static let kayOutlet = CallScript(
        banner: "Kay Outlet",
        note: "Ask these exact words at the outlet AND at its paired mainline Kay, same person, same day. The answer is the difference between the two, not either number on its own.",
        opener: "Hi, my name is [name]. I'm a high school student at Grace Church School in New York and I'm doing a research project on the jewellery business for our school investment club. Quick thing first, are you a Kay Outlet or a regular Kay? … Do you have two minutes for a few questions about what's in the store?",
        questions: [
            .init(text: "Do you have a plain 18 inch, 10 karat rope chain? What does that one cost?",
                  why: "If they carry no plain gold chains at all, write that down. It is itself the finding."),
            .init(text: "Right now, is everything in the store the same percent off, or are some things marked down more than others?", why: ""),
            .init(text: "On the actual ticket hanging off a piece, is there a second lower price printed on the ticket itself, or is the discount just on a sign in the case?", why: ""),
            .init(text: "When you get new stock in, where does it come from?",
                  why: "Open form. Do not suggest an answer. Wait."),
            .init(text: "Can you find me one piece that's marked down right now, and tell me what it was and what it is now?",
                  why: "Write the item description down exactly, and both prices."),
        ],
        followUps: "TWO FOR THE WHOLE CALL. After 4, only if they volunteer an origin: \"Does it come in already marked down, or do you mark it down here?\" After 5: \"What is that one, exactly?\" Get the description, not a category.",
        doNotAsk: "Do not tell them you are also calling their mainline sister store. That invites a story about how they differ instead of an observation. Never follow up on a piece count."
    )

    static let banter = CallScript(
        banner: "Banter",
        note: "Banter by Piercing Pagoda. Mall kiosks, no bridal. Confirm the banner before you start.",
        opener: "Hi, is this Banter? … My name is [name]. I'm a high school student at Grace Church School in New York and I'm doing a research project on the jewellery business for our school investment club. Do you have two minutes for a few questions about what's in the case?",
        questions: [
            .init(text: "When you sell a gold chain, is the price already on the tag, or do you weigh it and work it out off a gold price chart?",
                  why: "Whether the entry price point reprices with the metal or sits on a tag until it sells."),
            .init(text: "Gold has gone up a lot. Has what's in the case changed because of it?",
                  why: "Open. Do not suggest an answer."),
            .init(text: "When somebody walks up to the kiosk, are they usually there to get pierced or to buy something?",
                  why: "Which half of the kiosk is the business."),
            .init(text: "Have any other Banter kiosks near you closed in the last year or two?",
                  why: "Observable from where they stand, unlike anything about their own numbers."),
            .init(text: "If someone's buying a hundred and fifty dollar chain, do they usually pay for it outright or put it on the card?",
                  why: "The nearest thing to a consumer-health read that a person at a counter can actually see."),
        ],
        followUps: "TWO FOR THE WHOLE CALL, NOT TWO PER QUESTION. If they name a price, ask what it was before. If they say something has changed, ask when.",
        doNotAsk: "Engagement rings, bridal, anything at a $1,200 price point. Anything about what is selling well, which is a performance question wearing a stock question's clothes."
    )
}
