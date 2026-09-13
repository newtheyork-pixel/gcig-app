import SwiftUI
import AppKit

// MEET: meetings on the club's own server, started from the desk.
//
// The terminal does not carry the video. It creates the meeting, holds the
// list, and hands the member a link their browser opens. That division is
// deliberate: a Jitsi call wants a browser's media stack, and the terminal
// has no business reimplementing one. What the terminal is good at is being
// already open and one keystroke away when someone says "let's just get on
// a call".
//
// The token never lives here. Joining asks the API to mint one for the
// member and opens the URL it returns, so nothing durable on this machine
// can open a room.

private struct MeetingRow: Decodable, Identifiable, Equatable {
    let code: String
    let title: String
    let startsAt: Date?
    let durationMinutes: Int
    let url: String
    let createdAt: Date
    struct Creator: Decodable, Equatable { let id: Int; let name: String? }
    let createdBy: Creator?
    var id: String { code }
}

private struct MeetingList: Decodable { let meetings: [MeetingRow] }
private struct JoinReply: Decodable { let joinUrl: String; let title: String }
private struct EmailReply: Decodable { let sent: Bool; let to: String }

struct MeetPanel: View {
    @State private var rows: [MeetingRow] = []
    @State private var title: String = ""
    @State private var minutes: String = "60"
    @State private var schedule = false
    @State private var when = Date().addingTimeInterval(3600)
    @State private var status: String = ""
    @State private var loading = true
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(Term.border)
            composer
            Divider().background(Term.border)
            list
            if !status.isEmpty {
                Divider().background(Term.border)
                Text(status)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(Term.fgDim)
                    .padding(8)
            }
        }
        .background(Term.bg)
        .task { await load() }
    }

    private var header: some View {
        HStack {
            Text("MEET").font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundColor(Term.amber)
            Text("meet.thegriffinfund.org")
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(Term.fgMuted)
            Spacer()
            Button("REFRESH") { Task { await load() } }
                .buttonStyle(.plain)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(Term.fgDim)
        }
        .padding(8)
        .background(Term.bgHeader)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                TextField("What is the meeting", text: $title)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(Term.fg)
                    .padding(6)
                    .background(Term.bgPanel)
                    .border(Term.border)
                TextField("60", text: $minutes)
                    .textFieldStyle(.plain)
                    .frame(width: 46)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(Term.fg)
                    .padding(6)
                    .background(Term.bgPanel)
                    .border(Term.border)
                Text("min").font(.system(size: 10, design: .monospaced)).foregroundColor(Term.fgMuted)
            }
            HStack(spacing: 8) {
                Toggle("Schedule", isOn: $schedule)
                    .toggleStyle(.checkbox)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(Term.fgDim)
                if schedule {
                    DatePicker("", selection: $when)
                        .datePickerStyle(.compact)
                        .labelsHidden()
                        .font(.system(size: 11, design: .monospaced))
                }
                Spacer()
                Button(schedule ? "SCHEDULE" : "START NOW") {
                    Task { await create(joinAfter: !schedule) }
                }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundColor(title.trimmingCharacters(in: .whitespaces).isEmpty || busy
                                 ? Term.fgMuted : Term.amber)
                .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || busy)
            }
        }
        .padding(8)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if loading {
                    Text("loading…").font(.system(size: 11, design: .monospaced))
                        .foregroundColor(Term.fgMuted).padding(8)
                } else if rows.isEmpty {
                    Text("no meetings").font(.system(size: 11, design: .monospaced))
                        .foregroundColor(Term.fgMuted).padding(8)
                } else {
                    ForEach(rows) { row in
                        rowView(row)
                        Divider().background(Term.border.opacity(0.4))
                    }
                }
            }
        }
    }

    private func rowView(_ m: MeetingRow) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(m.title)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(Term.fg)
                    .lineLimit(1)
                Text(subtitle(m))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(Term.fgMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            action("JOIN")  { Task { await join(m) } }
            action("COPY")  { copy(m) }
            action("EMAIL") { Task { await email(m) } }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
    }

    private func action(_ label: String, _ run: @escaping () -> Void) -> some View {
        Button(label, action: run)
            .buttonStyle(.plain)
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .foregroundColor(Term.fgDim)
    }

    private func subtitle(_ m: MeetingRow) -> String {
        let who = m.createdBy?.name ?? ""
        let f = DateFormatter()
        f.dateFormat = "EEE d MMM h:mm a"
        if let s = m.startsAt {
            return "\(f.string(from: s)) · \(m.durationMinutes) min\(who.isEmpty ? "" : " · \(who)")"
        }
        f.dateFormat = "h:mm a"
        return "opened \(f.string(from: m.createdAt))\(who.isEmpty ? "" : " · \(who)")"
    }

    // --- actions ---------------------------------------------------------

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let data = try await API.shared.get("/meet/meetings")
            rows = try await API.shared.decode(MeetingList.self, from: data).meetings
        } catch {
            status = "could not load meetings: \(error.localizedDescription)"
        }
    }

    private func create(joinAfter: Bool) async {
        let t = title.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return }
        busy = true
        defer { busy = false }
        var body: [String: Any] = ["title": t, "durationMinutes": Int(minutes) ?? 60]
        if schedule {
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime]
            body["startsAt"] = iso.string(from: when)
        }
        do {
            let data = try await API.shared.post("/meet/meetings", json: body)
            let made = try await API.shared.decode(MeetingRow.self, from: data)
            title = ""
            await load()
            status = schedule ? "scheduled · link ready to copy" : "created"
            if joinAfter { await join(made) }
        } catch {
            status = "could not create: \(error.localizedDescription)"
        }
    }

    // Joining mints a token for THIS member and opens the browser with it.
    // Nothing that can open a room is stored on the machine.
    private func join(_ m: MeetingRow) async {
        do {
            let data = try await API.shared.post("/meet/meetings/\(m.code)/token", json: [:])
            let reply = try await API.shared.decode(JoinReply.self, from: data)
            if let url = URL(string: reply.joinUrl) { NSWorkspace.shared.open(url) }
            status = "opened \(reply.title) in your browser"
        } catch {
            status = "could not open: \(error.localizedDescription)"
        }
    }

    // The copied link carries no token, so it is safe to paste anywhere.
    private func copy(_ m: MeetingRow) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(m.url, forType: .string)
        status = "link copied"
    }

    private func email(_ m: MeetingRow) async {
        do {
            let data = try await API.shared.post("/meet/meetings/\(m.code)/email", json: [:])
            let reply = try await API.shared.decode(EmailReply.self, from: data)
            status = "link sent to \(reply.to)"
        } catch {
            status = "could not send: \(error.localizedDescription)"
        }
    }
}
