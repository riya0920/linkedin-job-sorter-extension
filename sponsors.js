// Sponsor list — OPTIONAL. This stub ships EMPTY so the extension loads cleanly.
//
// The extension can badge employers that are known H-1B visa sponsors, with
// their approval counts. To enable that, replace this file with your own list
// built from public USCIS H-1B disclosure data, in this exact shape:
//
//   var LJS_SPONSOR_ROWS = [["EMPLOYER NAME", 123], ["ANOTHER EMPLOYER", 45]];
//
//   • first element  = employer name as it appears in the H-1B data
//   • second element = number of new H-1B approvals (0 if unknown)
//
// A good source is the public USCIS H-1B Employer Data Hub. With this stub in
// place, everything else (sorting, reposts, salary, seen/applied) works fully;
// only the green "sponsor" badge stays inactive until you supply a list.
var LJS_SPONSOR_ROWS = [];
var LJS_SPONSOR_COMPANIES = LJS_SPONSOR_ROWS.map(function (r) { return r[0]; });
