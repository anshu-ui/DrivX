/**
 * The words behind "Terms and Conditions" and "Privacy Policy", one set per role.
 *
 * The owner's instruction of 2026-10-27 was to build these *"sach ke hisaab se
 * dekh ke"* — so every clause below describes something the software actually
 * does today, and nothing describes a feature that does not exist. Where the
 * product has a known gap (account deletion is not built, cash payment is not
 * recorded against a trip), the text says so instead of inventing a process.
 *
 * This is a draft for the office to approve, not a legal opinion: it is written
 * from the code, and it names the rupee figures and the data paths the code
 * really uses.
 */

export type LegalSection = { heading: string; lines: string[] };
export type LegalDocument = { title: string; updatedNote: string; sections: LegalSection[] };
export type LegalRole = 'customer' | 'driver';

const CUSTOMER_TERMS: LegalDocument = {
  title: 'Terms and Conditions — for customers',
  updatedNote: 'Describes how DrivX works today. The office reviews this wording before launch.',
  sections: [
    {
      heading: 'What you are booking',
      lines: [
        'DrivX supplies a verified chauffeur to drive. On the chauffeur services the car is yours — "Safar aapka, driver hamara" — and you stay responsible for it while it is being driven. Cab services shown as disabled in the app are not bookable yet.',
        'A driver reaches you only after the office has verified their Aadhaar, driving licence and photograph and recorded the one-time registration fee.',
      ],
    },
    {
      heading: 'The fare you are shown',
      lines: [
        'The price on the confirmation screen is calculated by DrivX from the rate card in force at that moment: a fixed band for the distance of your route, plus the configured extra-distance amount only beyond the band you were quoted, plus a one-time night charge if your scheduled pickup is between 22:00 and 06:00 or the map-estimated journey overlaps those hours, plus any configured tax; tax is not assumed until the Admin sets it.',
        'One band prices the whole route. Bands are never added together, and driving further than the map estimated does not move you onto a bigger band — it adds the extra kilometres at the per-kilometre rate.',
        'The band you confirmed stays the price of the band even if the trip turns out shorter.',
      ],
    },
    {
      heading: 'The two codes, and what they start',
      lines: [
        'DrivX generates one start code and one end code against your booking id. You do not choose them and the office does not type them. They do not expire, and each works exactly once — no new pair is issued for the same booking.',
        'The trip cannot start until your driver enters your start code with the odometer reading at the car. It cannot close until they enter the end code with the reading at the drop.',
        'Keep both codes to yourself and read them to the driver at the car. A trip started on a code you did not give is a trip you should tell us about immediately.',
      ],
    },
    {
      heading: 'The bill is built from the odometer',
      lines: [
        'Your final bill is priced from the two readings your driver reports, on the same rate card you were quoted against. The receipt shows both readings, the distance they add up to, the distance the map estimated, and every line that made up the total.',
        'Where the dial shows more kilometres than the map promised, you pay the difference at ₹12 per kilometre. Where it shows fewer, you still pay the band you confirmed.',
        'Nothing on your phone can change a fare, a status or a code. Those are written by DrivX, and the rules refuse the attempt.',
      ],
    },
    {
      heading: 'Paying',
      lines: [
        'Settle the fare with your driver at the end of the trip, the way the office tells you to. DrivX does not take payment from you in the app, and no online payment method is switched on.',
        'What the platform keeps from the driver is DrivX\'s business with the driver, not a charge on your bill.',
      ],
    },
    {
      heading: 'Cancelling',
      lines: [
        'Only you can cancel a booking, and only while it has not started: requested, waiting for a driver, assigned, on the way, or arrived. Cancelling asks for a reason from a fixed list, and nothing is charged for it today.',
        'A driver cannot cancel your trip. If they cannot attend, the booking comes back to the office and you keep it.',
      ],
    },
    {
      heading: 'Rating the drive',
      lines: [
        'Once a trip has closed, your trip screen offers one rating for the driver who drove it: one to five stars, optional chips about the drive, and anything you want to add in words.',
        'It is sent to DrivX, not typed into a record you can edit. The score is folded into the driver\'s published average and appears on their own Account screen with the trip reference beside it. One rating per trip, and it cannot be changed afterwards.',
        'You cannot rate a trip that was cancelled, and you cannot rate one that has not closed.',
      ],
    },
    {
      heading: 'Problem with a trip',
      lines: [
        'Open a support ticket from the Account tab. It goes to the DrivX operations team with your booking reference. Assignment and resolution are recorded by staff; you can add replies and read the outcome.',
      ],
    },
  ],
};

const CUSTOMER_PRIVACY: LegalDocument = {
  title: 'Privacy Policy — for customers',
  updatedNote: 'Names the data this app really holds. The office reviews this wording before launch.',
  sections: [
    {
      heading: 'What we collect about you',
      lines: [
        'Your mobile number, which is your sign-in. Your name and email, if you add them. Saved places you choose to keep. The pickup and drop of each trip, with the coordinates you selected. Your trip record: the codes issued, the fare quoted, the fare billed.',
        'The rating you give a driver once a trip has closed. It is stored against that trip with the score, the chips you ticked and your words, and the driver they were about reads them. Your name is not on that row — the rules give a driver no read on your profile, so a rating reaches them with the trip reference and nothing about you.',
        'An emergency contact if you choose to record one.',
      ],
    },
    {
      heading: 'What your driver sees',
      lines: [
        'The driver assigned to you sees the trip: pickup, drop, the fare terms, and your contact number for that trip. Your saved places, your other trips and your account details are not on that screen.',
      ],
    },
    {
      heading: 'What you see of your driver',
      lines: [
        'When a driver is assigned, DrivX puts their name, phone number, photograph, driver reference, the car to look for, and the ratings and trip count the office already holds onto your trip. They are shared for that trip only. Their document numbers, what they owe the office, and where they live are never shown to you.',
      ],
    },
    {
      heading: 'Location',
      lines: [
        'The car\'s position is published only while a trip is running, and only to you and to your driver. It stops the moment the trip ends — the gate that lets it through is closed by DrivX at completion, not by the phone.',
        'Your own live position is not collected. Pickup comes from where you point on the map or from a place you saved.',
      ],
    },
    {
      heading: 'How long we keep it',
      lines: [
        'Sign-in codes expire in minutes. Trip codes stay until they are used. Bookings, trip events, bills and support tickets are kept as business records, because a fare and a dispute both need the original.',
        'Not yet automated, and said plainly: deleting an account is not a button in this app. Ask us through a support ticket and we handle it.',
      ],
    },
    {
      heading: 'What we do not do',
      lines: [
        'We do not sell your data, and we do not store a shareable link to anybody\'s photograph. Each person who is allowed to see an image asks for their own link, and the rules decide then.',
      ],
    },
    {
      heading: 'Marketing messages',
      lines: [
        'Off unless you turn them on in the Account tab. Trip notifications are not marketing and cannot be switched off from here.',
      ],
    },
  ],
};

const DRIVER_TERMS: LegalDocument = {
  title: 'Terms and Conditions — for drivers',
  updatedNote: 'Describes how DrivX works today. The office reviews this wording before launch.',
  sections: [
    {
      heading: 'Joining',
      lines: [
        'Three things are required and nothing else: your photograph, your Aadhaar card, and your driving licence. The office reviews them; DrivX does not accept an insurance certificate, a vehicle registration, a fitness certificate or a police verification from a driver, because on a chauffeur trip the car belongs to the customer.',
        'A one-time registration fee is raised when you first upload a document. The current default is ₹500 plus 5% GST (₹525 total); the amount shown in your account is the amount payable through Cashfree. Upload all required documents and wait for Admin approval before bookings are enabled.',
        'Approval mints your driver reference. It is the identity that appears on a customer\'s trip.',
      ],
    },
    {
      heading: 'Documents stay true',
      lines: [
        'You upload your own documents. A re-filed document after a rejection goes back to the office for review; it does not reopen Duty by itself.',
        'DrivX does not ask you for car paperwork, because the car is not yours to certify. You may record the make, model and number plate you drive from your own Account screen, and the office can record them too — either way that is what the customer is told to look for at the pickup point.',
      ],
    },
    {
      heading: 'Starting and closing a trip',
      lines: [
        'A trip starts only on the customer\'s start code, entered with the odometer reading at the car. It closes only on their end code, entered with the reading at the drop. Both codes work once and neither expires.',
        'You cannot change a fare, a booking status, a code or a rating. Those are written by DrivX.',
        'Post readings honestly. The whole bill — and your commission — is computed between the two you report.',
      ],
    },
    {
      heading: 'Commission',
      lines: [
        'On each completed trip the office keeps the configured commission (13% by default) and any Admin-configured tax on that share. The rate and amount are recorded on that trip.',
        'An unpaid commission row holds the next booking. Duty will refuse to go online while money is outstanding, and says how much.',
        'Payment runs through Cashfree only. Until that is live on this account, the office records a cash or UPI collection against a reference and the ledger shows who recorded it.',
      ],
    },
    {
      heading: 'What the customer sees of you',
      lines: [
        'Your name, phone number, photograph, driver reference, the car, and your rating and trip count are published to the customer for the duration of the trip. Your Aadhaar number, your licence number, what you owe and where you live are not.',
        'The contact number is shared for that trip. Do not use it for anything else.',
      ],
    },
    {
      heading: 'Refusing work, and conduct',
      lines: [
        'Declining an offer returns the booking to the office; the customer keeps it. A driver has no power to cancel a customer\'s trip.',
        'The customer\'s car is in your care. Damage, delay or a dispute about a reading goes to a support ticket, and the booking\'s event log — codes used, readings posted, times stamped — is what the office reads first.',
      ],
    },
  ],
};

const DRIVER_PRIVACY: LegalDocument = {
  title: 'Privacy Policy — for drivers',
  updatedNote: 'Names the data this app really holds. The office reviews this wording before launch.',
  sections: [
    {
      heading: 'What we hold about you',
      lines: [
        'Your mobile number and name, your languages and work zone, your verification status and the date it was decided, your driver reference, and the make, model and plate you or the office record for the car you drive.',
        'Your three documents: the photograph, the Aadhaar image and the licence image, uploaded by you.',
      ],
    },
    {
      heading: 'Who can see your documents',
      lines: [
        'The files you upload sit at a path only you and DrivX staff can open. The reviewer sees them; the customer never does.',
        'A customer sees your profile photograph and nothing else from your files. That photograph is a separate copy, in a place any signed-in user may read, and no download link to it is ever stored on the record.',
        'Your Aadhaar and licence numbers are not put on your booking, your trip card, or any screen a customer opens.',
      ],
    },
    {
      heading: 'What the customer sees',
      lines: [
        'On the trip you are carrying: name, number, photograph, driver reference, rating average and count, trips driven, and the car. That copy is written onto the booking when you are assigned and is removed with the booking\'s history — it is not a window into your profile.',
      ],
    },
    {
      heading: 'Your money',
      lines: [
        'One ledger row per completed trip, with the base, configured tax on the office\'s share, total, rate and status; and the one-time registration fee. You read your own bill. Staff read the outstanding list. No other driver sees any of it.',
        'Nothing is marked paid by you. Only the office\'s recorded collection — or Cashfree, once it is live — moves a row to paid, and each collection writes an audit entry naming who recorded it.',
      ],
    },
    {
      heading: 'Location and presence',
      lines: [
        'Your position is published to the customer of a running trip only, for as long as that trip runs. Going offline stops it, and the completion of a trip closes the gate that allowed it.',
        'Stale positions are swept, and a fake reading — out of range, or coordinates that cannot be true — is refused before it is stored.',
      ],
    },
    {
      heading: 'How long, and how to get out',
      lines: [
        'Documents and your profile are kept while your account is active. Account deletion is not automated in this app yet; raise a ticket and the office handles it.',
        'A rejected or withdrawn application is kept as the record of that decision, because the queue and the audit trail depend on it.',
      ],
    },
  ],
};

const BY_ROLE: Record<LegalRole, { terms: LegalDocument; privacy: LegalDocument }> = {
  customer: { terms: CUSTOMER_TERMS, privacy: CUSTOMER_PRIVACY },
  driver: { terms: DRIVER_TERMS, privacy: DRIVER_PRIVACY },
};

export const legalDocumentsFor = (role: LegalRole) => BY_ROLE[role];
