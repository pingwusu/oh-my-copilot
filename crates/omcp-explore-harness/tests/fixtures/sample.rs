// Fixture for the symbols + grep tests.
pub struct Widget {
    pub id: u32,
}

pub enum Shape {
    Square,
    Circle,
}

pub trait Draw {
    fn draw(&self);
}

impl Draw for Widget {
    fn draw(&self) {
        println!("drawing widget MARKER_NEEDLE");
    }
}

pub fn make_widget(id: u32) -> Widget {
    Widget { id }
}

fn private_helper() -> u32 {
    42
}
